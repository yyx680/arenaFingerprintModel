// Incremental, read-only scan of this account's REVEALED Battle sessions.
// Only a positive cache-write token count paired to the same message's positive /cost
// cache-write USD amount becomes an observed rate. No message text or cookies are saved.
// Usage: node tools/expr/arena-battle-write-scan.mjs [pages=1]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const pages = Math.max(1, Math.min(8, Number(process.argv[2] || 1) || 1));
const refresh = process.argv.includes('--refresh');
const outPath = path.resolve('arena-cache-write-observed.json');
const catalog = JSON.parse(fs.readFileSync('arena-pricing-table.json', 'utf8'));
const schema = 'arena-cache-write-observed-v1';
let doc;
if (fs.existsSync(outPath)) {
  doc = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  if (doc.schema !== schema || !Array.isArray(doc.observations)) {
    throw new Error('Existing JSON has a different schema; refusing to overwrite it');
  }
} else {
  doc = {
    schema,
    created_at: new Date().toISOString(),
    catalog_source: catalog.source,
    catalog_fetched_at: catalog.fetched_at,
    catalog_total: catalog.rows.length,
    evidence: 'Same revealed Battle assistant message: provider metadata.usage.cacheWriteTokens > 0 AND actual.cacheWriteTokensCostUsd > 0 from /api/evaluation/:id/cost',
    unit: 'usd_per_million_cache_write_tokens',
    warning: 'Unobserved models have null actual write rate. Each observed rate is effective for its message; a message aggregating calls or TTL tiers can yield a blended rate. Battle observations do not prove Agent pricing; provider, tier and time may differ.',
    pages_scanned: 0,
    history_entries_seen: 0,
    revealed_battle_sessions_seen: 0,
    next_cursor: null,
    history_complete: false,
    observations: [],
    models: [],
    additional_observed_models: [],
  };
}
if (refresh) {
  // Rescan from the newest page after new Battles; observations are deduplicated by hash.
  doc.next_cursor = null;
  doc.history_complete = false;
  doc.pages_scanned = 0;
  doc.history_entries_seen = 0;
  doc.revealed_battle_sessions_seen = 0;
  doc.incomplete_due_to_request_errors = false;
  doc.request_errors = 0;
}

const targets = await fetch('http://127.0.0.1:9333/json/list').then(r => r.json());
const page = targets.find(p => p.type === 'page' && p.url.startsWith('https://arena.ai/'));
if (!page) throw new Error('Open arena.ai in the dedicated Chrome window');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener('message', e => {
  const msg = JSON.parse(e.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const p = pending.get(msg.id);
  pending.delete(msg.id);
  msg.error ? p.reject(msg.error) : p.resolve(msg.result);
});
const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

function rebuildModels() {
  const groups = new Map();
  for (const o of doc.observations) {
    const key = o.model_id;
    if (!groups.has(key)) groups.set(key, { model_id: key, model_name: o.model_name, observations: [] });
    groups.get(key).observations.push(o);
  }
  const summary = g => {
    if (!g) return { observed_write_usd_per_mtok: null, observed_rates_usd_per_mtok: [], sample_count: 0 };
    const rates = [...new Set(g.observations.map(o => o.write_usd_per_mtok))].sort((a, b) => a - b);
    return {
      observed_write_usd_per_mtok: rates.length === 1 ? rates[0] : null,
      observed_rates_usd_per_mtok: rates,
      sample_count: g.observations.length,
    };
  };
  // Exact model-key equality only: a Battle name cannot safely be mapped to an Agent variant.
  doc.models = catalog.rows.map(r => {
    const group = [...groups.values()].find(g => g.model_name === r.model_key);
    return { model_key: r.model_key, ...summary(group) };
  });
  const keys = new Set(catalog.rows.map(r => r.model_key));
  doc.additional_observed_models = [...groups.values()]
    .filter(g => !keys.has(g.model_name))
    .map(g => ({ model_name: g.model_name, model_id: g.model_id, ...summary(g) }));
  doc.observed_distinct_models = groups.size;
  doc.updated_at = new Date().toISOString();
}

try {
  for (let pageIndex = 0; pageIndex < pages && !doc.history_complete; pageIndex += 1) {
    const cursor = doc.next_cursor;
    const expression = `(${async function (cursor) {
      const q = new URLSearchParams({ limit: '50', includeArchived: 'false' });
      if (cursor) q.set('cursor', cursor);
      const hr = await fetch('/api/history/unified?' + q, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
      if (!hr.ok) return { error: 'history-' + hr.status };
      const h = await hr.json();
      const entries = h.entries || [];
      const revealed = [];
      let index = 0;
      let evalErrors = 0;
      async function worker() {
        while (index < entries.length) {
          const entry = entries[index++];
          if (!entry?.id || entry.type !== 'evaluation' || entry.mode !== 'battle') continue;
          try {
            const er = await fetch('/api/evaluation/' + entry.id, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
            if (!er.ok) { evalErrors += 1; continue; }
            const j = await er.json();
            const names = new Map((j.revealedModels || []).map(m => [m.id, m]));
            if (j.mode !== 'battle' || !names.size) continue;
            const matches = (j.messages || []).filter(m => m.role === 'assistant' && names.has(m.modelId) && Number(m.metadata?.usage?.cacheWriteTokens) > 0);
            revealed.push({ session_id: entry.id, messages: matches.map(m => ({
              message_id: m.id,
              model_id: m.modelId,
              model_name: names.get(m.modelId).displayName || names.get(m.modelId).publicName,
              model_provider: names.get(m.modelId).provider || null,
              write_tokens: m.metadata.usage.cacheWriteTokens,
              usage_source: m.metadata.usage.usageSource || null,
            })) });
          } catch { evalErrors += 1; }
        }
      }
      await Promise.all(Array.from({ length: 2 }, worker));
      const flagKey = 'ph-toolbar-overrides';
      const flagValue = JSON.stringify({ 'credit-system-m1': 'cost-shown' });
      const existing = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith(flagKey + '='));
      let prior = null;
      try { if (existing) prior = decodeURIComponent(existing.slice(flagKey.length + 1)); } catch {}
      if (existing && prior !== flagValue) return { error: 'different-cost-override-exists' };
      const observations = [];
      let costErrors = 0;
      let cleared = null;
      if (revealed.some(x => x.messages.length)) {
        if (!existing) document.cookie = flagKey + '=' + encodeURIComponent(flagValue) + '; Path=/; Max-Age=60; SameSite=Lax; Secure';
        try {
          for (const row of revealed.filter(x => x.messages.length)) {
            try {
              const cr = await fetch('/api/evaluation/' + row.session_id + '/cost', { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
              if (!cr.ok) { costErrors += 1; continue; }
              const byId = (await cr.json()).messages || {};
              for (const m of row.messages) {
                const actual = byId[m.message_id]?.actual;
                const usd = actual?.cacheWriteTokensCostUsd;
                if (!(Number.isFinite(usd) && usd > 0)) continue;
                observations.push({ ...m, session_id: row.session_id, message_id: m.message_id,
                  write_cost_usd: usd, cost_source: actual.source || null });
              }
            } catch { costErrors += 1; }
          }
        } finally {
          if (!existing) {
            document.cookie = flagKey + '=; Path=/; Max-Age=0; SameSite=Lax; Secure';
            cleared = !document.cookie.split(';').some(x => x.trim().startsWith(flagKey + '='));
          }
        }
      }
      return { entries: entries.length, has_more: h.pagination?.hasMore === true,
        next_cursor: h.pagination?.cursor || null, revealed_sessions: revealed.length,
        eval_errors: evalErrors, cost_errors: costErrors, override_cleared: cleared, observations };
    }})(${JSON.stringify(cursor)})`;
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    const pageResult = result.result?.value;
    if (!pageResult || pageResult.error) throw new Error(pageResult?.error || 'No scan result');
    if (pageResult.override_cleared === false) throw new Error('Temporary cost override did not clear; no data written');
    if (pageResult.eval_errors || pageResult.cost_errors) {
      doc.incomplete_due_to_request_errors = true;
      doc.request_errors = (doc.request_errors || 0) + pageResult.eval_errors + pageResult.cost_errors;
    }
    const seen = new Set(doc.observations.map(o => o.sample_hash));
    let added = 0;
    for (const sample of pageResult.observations) {
      const sampleHash = createHash('sha256').update(sample.session_id + ':' + sample.message_id).digest('hex').slice(0, 20);
      if (seen.has(sampleHash)) continue;
      const rate = Number((sample.write_cost_usd * 1e6 / sample.write_tokens).toFixed(9));
      if (!(rate > 0 && Number.isFinite(rate))) continue;
      const { session_id, message_id, ...publicSample } = sample;
      doc.observations.push({ ...publicSample, sample_hash: sampleHash, write_usd_per_mtok: rate });
      seen.add(sampleHash);
      added += 1;
    }
    doc.pages_scanned += 1;
    doc.history_entries_seen += pageResult.entries;
    doc.revealed_battle_sessions_seen += pageResult.revealed_sessions;
    doc.next_cursor = pageResult.has_more ? pageResult.next_cursor : null;
    doc.history_complete = !pageResult.has_more;
    rebuildModels();
    fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ page: doc.pages_scanned, entries: pageResult.entries,
      revealed: pageResult.revealed_sessions, added, observedModels: doc.observed_distinct_models,
      hasMore: !doc.history_complete, errors: pageResult.eval_errors + pageResult.cost_errors }));
    if (pageResult.entries === 0 || (pageResult.has_more && !pageResult.next_cursor)) break;
  }
} finally { ws.close(); }
