// Build a provenance-separated price fingerprint for exact Arena model keys.
// Read-only against revealed Battle sessions; never records message text or cookies.
// Usage: node tools/expr/arena-model-price-fingerprint.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const catalog = JSON.parse(fs.readFileSync('arena-pricing-table.json', 'utf8'));
const cacheRef = JSON.parse(fs.readFileSync('arena-cache-rates.json', 'utf8'));
const writeEvidence = JSON.parse(fs.readFileSync('arena-cache-write-observed.json', 'utf8'));
const outPath = path.resolve('arena-model-price-fingerprint.json');
const previous = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null;
if (previous && previous.schema !== 'arena-model-price-fingerprint-v1') {
  throw new Error('Existing price fingerprint has a different schema');
}
const training = fs.existsSync('arena-battle-price-training.json')
  ? JSON.parse(fs.readFileSync('arena-battle-price-training.json', 'utf8')) : null;
if (training && training.schema !== 'arena-battle-price-training-v1') {
  throw new Error('Existing Battle training set has a different schema');
}
const knownMessageIds = new Set((training?.battles || []).flatMap(b =>
  b.turns.flatMap(t => t.candidates.filter(c => c.price_evidence).map(c => c.message_id))));
// Completed one-turn Battle sessions already contain the revealed labels and paired costs.
// Skip their redundant /evaluation requests; still page all history to discover new sessions.
const knownSessionIds = new Set((training?.battles || [])
  .filter(b => b.turns?.length === 1 && b.turns[0].candidates?.length === 2
    && b.turns[0].candidates.every(c => c.price_evidence))
  .map(b => b.session_id));
const buckets = [
  ['input', 'inputTokens', 'inputTokensCostUsd'],
  ['output', 'outputTokens', 'outputTokensCostUsd'],
  ['cache_read', 'cacheReadTokens', 'cacheReadTokensCostUsd'],
  ['cache_write', 'cacheWriteTokens', 'cacheWriteTokensCostUsd'],
];
const rate = (tokens, usd) =>
  Number.isFinite(tokens) && tokens > 0 && Number.isFinite(usd) && usd > 0
    ? Number((usd * 1e6 / tokens).toFixed(9)) : null;
const numberOrNull = value => Number.isFinite(value) ? value : null;
const hash = (session, message) => createHash('sha256')
  .update(session + ':' + message).digest('hex').slice(0, 20);

const targets = await fetch('http://127.0.0.1:9333/json/list').then(r => r.json());
const page = targets.find(p => p.type === 'page' && p.url.startsWith('https://arena.ai/'));
if (!page) throw new Error('Dedicated Arena Chrome tab not found');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
let nextId = 0;
const pending = new Map();
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (!pending.has(message.id)) return;
  const task = pending.get(message.id);
  pending.delete(message.id);
  message.error ? task.reject(message.error) : task.resolve(message.result);
});
function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
}

const observations = [...(previous?.observations || [])];
const observationHashes = new Set(observations.map(o => o.sample_hash));
const errors = [];
let cursor = null;
let historyEntries = 0;
let revealedSessions = 0;
let unpairedMessages = 0;
let excludedNonUpstream = 0;
let pages = 0;
let complete = false;
try {
  for (; pages < 8 && !complete; pages += 1) {
    const data = await evaluate(`(${async function (cursor, knownIds, knownSessions) {
      const alreadyPaired = new Set(knownIds);
      const alreadyComplete = new Set(knownSessions);
      const qs = new URLSearchParams({ limit: '50', includeArchived: 'false' });
      if (cursor) qs.set('cursor', cursor);
      const history = await fetch('/api/history/unified?' + qs, {
        credentials: 'same-origin', signal: AbortSignal.timeout(20000),
      });
      if (!history.ok) return { error: 'history-' + history.status };
      const h = await history.json();
      const entries = h.entries || [];
      const battles = entries.filter(e => e?.id && e.type === 'evaluation' && e.mode === 'battle');
      const unseenBattles = battles.filter(e => !alreadyComplete.has(e.id));
      const sessions = [];
      const problems = [];
      let revealedCount = battles.length - unseenBattles.length;
      let index = 0;
      async function evalWorker() {
        while (index < unseenBattles.length) {
          const entry = unseenBattles[index++];
          try {
            const response = await fetch('/api/evaluation/' + entry.id, {
              credentials: 'same-origin', signal: AbortSignal.timeout(20000),
            });
            if (!response.ok) { problems.push('evaluation-' + response.status); continue; }
            const j = await response.json();
            const names = new Map((j.revealedModels || []).map(m => [m.id, m]));
            if (!names.size || j.mode !== 'battle') continue;
            revealedCount += 1;
            const messages = (j.messages || []).filter(m =>
              m.role === 'assistant' && names.has(m.modelId) && !alreadyPaired.has(m.id))
              .map(m => ({
                id: m.id,
                model_id: m.modelId,
                model_name: names.get(m.modelId).displayName || names.get(m.modelId).publicName,
                model_provider: names.get(m.modelId).provider || null,
                usage: m.metadata?.usage || null,
              }));
            if (messages.length) sessions.push({ session_id: entry.id, messages });
          } catch (error) { problems.push('evaluation-' + String(error).slice(0, 80)); }
        }
      }
      await Promise.all([evalWorker(), evalWorker()]);

      const flagKey = 'ph-toolbar-overrides';
      const flagValue = JSON.stringify({ 'credit-system-m1': 'cost-shown' });
      const existing = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith(flagKey + '='));
      let oldValue = null;
      try { if (existing) oldValue = decodeURIComponent(existing.slice(flagKey.length + 1)); } catch {}
      if (existing && oldValue !== flagValue) return { error: 'different-cost-override-exists' };
      const rows = [];
      let unpairedMessages = 0;
      let excludedNonUpstream = 0;
      let overrideCleared = null;
      if (sessions.length) {
        if (!existing) document.cookie = flagKey + '=' + encodeURIComponent(flagValue)
          + '; Path=/; Max-Age=60; SameSite=Lax; Secure';
        try {
          // Sequential /cost calls avoid bursts while a Battle generation limit is active.
          for (const session of sessions) {
            try {
              const response = await fetch('/api/evaluation/' + session.session_id + '/cost', {
                credentials: 'same-origin', signal: AbortSignal.timeout(20000),
              });
              if (!response.ok) { problems.push('cost-' + response.status); continue; }
              const byId = (await response.json()).messages || {};
              for (const message of session.messages) {
                const actual = byId[message.id]?.actual;
                if (!actual) { unpairedMessages += 1; continue; }
                if (actual.source === 'agent_p50') { excludedNonUpstream += 1; continue; }
                rows.push({ ...message, session_id: session.session_id, actual });
              }
            } catch (error) { problems.push('cost-' + String(error).slice(0, 80)); }
          }
        } finally {
          if (!existing) {
            document.cookie = flagKey + '=; Path=/; Max-Age=0; SameSite=Lax; Secure';
            overrideCleared = !document.cookie.split(';').some(x => x.trim().startsWith(flagKey + '='));
          }
        }
      }
      return {
        entries: entries.length, revealed_sessions: revealedCount, rows,
        problems, unpaired_messages: unpairedMessages,
        excluded_non_upstream: excludedNonUpstream, override_cleared: overrideCleared,
        has_more: h.pagination?.hasMore === true,
        next_cursor: h.pagination?.cursor || null,
      };
    }})(${JSON.stringify(cursor)}, ${JSON.stringify([...knownMessageIds])}, ${JSON.stringify([...knownSessionIds])})`);
    if (!data || data.error) throw new Error(data?.error || 'Empty scan page');
    if (data.override_cleared === false) throw new Error('Temporary cookie override not cleared');
    historyEntries += data.entries;
    revealedSessions += data.revealed_sessions;
    unpairedMessages += data.unpaired_messages || 0;
    excludedNonUpstream += data.excluded_non_upstream || 0;
    errors.push(...data.problems);
    for (const raw of data.rows) {
      const sampleHash = hash(raw.session_id, raw.id);
      if (observationHashes.has(sampleHash)) continue;
      observationHashes.add(sampleHash);
      const parts = {};
      for (const [name, tokenKey, costKey] of buckets) {
        const tokens = raw.usage?.usageSource === 'provider'
          ? numberOrNull(raw.usage?.[tokenKey]) : null;
        const cost = numberOrNull(raw.actual?.[costKey]);
        parts[name] = { tokens, cost_usd: cost, effective_usd_per_mtok: rate(tokens, cost) };
      }
      observations.push({
        sample_hash: sampleHash,
        model_id: raw.model_id, model_name: raw.model_name,
        model_provider: raw.model_provider,
        usage_source: raw.usage?.usageSource || null,
        cost_source: raw.actual?.source || null,
        total_tokens: numberOrNull(raw.usage?.totalTokens),
        reasoning_tokens: numberOrNull(raw.usage?.reasoningTokens),
        actual_total_cost_usd: numberOrNull(raw.actual?.totalCostUsd),
        components: parts,
      });
    }
    console.log(JSON.stringify({ page: pages + 1, entries: data.entries,
      revealed: data.revealed_sessions, paired_messages: data.rows.length,
      unpaired_messages: data.unpaired_messages,
      errors: data.problems.length, has_more: data.has_more }));
    complete = !data.has_more;
    cursor = data.next_cursor;
    if (data.has_more && !cursor) throw new Error('History cursor missing');
    if (errors.length) throw new Error('History/cost API errors: ' + errors.slice(0, 5).join(', '));
  }
} finally { ws.close(); }
if (!complete) throw new Error('History still has more pages; no output written');

// Preserve already proven cache-write samples if a historical session was later removed.
const existingHashes = new Set(observations.map(o => o.sample_hash));
for (const old of writeEvidence.observations || []) {
  if (existingHashes.has(old.sample_hash)) continue;
  observations.push({
    sample_hash: old.sample_hash,
    model_id: old.model_id, model_name: old.model_name,
    model_provider: old.model_provider,
    usage_source: old.usage_source || null,
    cost_source: old.cost_source || null,
    total_tokens: null, reasoning_tokens: null, actual_total_cost_usd: null,
    components: {
      input: { tokens: null, cost_usd: null, effective_usd_per_mtok: null },
      output: { tokens: null, cost_usd: null, effective_usd_per_mtok: null },
      cache_read: { tokens: null, cost_usd: null, effective_usd_per_mtok: null },
      cache_write: {
        tokens: old.write_tokens, cost_usd: old.write_cost_usd,
        effective_usd_per_mtok: old.write_usd_per_mtok,
      },
    },
    carried_from_write_evidence: true,
  });
  existingHashes.add(old.sample_hash);
}

const groups = new Map();
for (const o of observations) {
  if (!groups.has(o.model_name)) groups.set(o.model_name, []);
  groups.get(o.model_name).push(o);
}
function summary(samples) {
  const result = { model_ids: [...new Set(samples.map(s => s.model_id))], message_samples: samples.length };
  for (const [bucket] of buckets) {
    const valid = samples.filter(s => (s.components[bucket]?.tokens ?? 0) > 0
      && Number.isFinite(s.components[bucket]?.cost_usd));
    const positive = valid.map(s => s.components[bucket].effective_usd_per_mtok)
      .filter(v => Number.isFinite(v) && v > 0);
    const distinct = [...new Set(positive)].sort((a, b) => a - b);
    result[bucket] = {
      observed_usd_per_mtok: distinct.length === 1 ? distinct[0] : null,
      distinct_positive_rates_usd_per_mtok: distinct,
      positive_cost_samples: positive.length,
      reported_zero_cost_samples: valid.filter(s => s.components[bucket].cost_usd === 0).length,
      cost_sources: [...new Set(valid.map(s => s.cost_source).filter(Boolean))],
    };
  }
  return result;
}
const modelKeys = new Set(catalog.rows.map(r => r.model_key));
const models = catalog.rows.map(row => {
  const ref = cacheRef.rates[row.model_key];
  return {
    model_key: row.model_key, display: row.display, organization: row.org,
    published: {
      input_usd_per_mtok: numberOrNull(row.input_usd_per_mtok),
      output_usd_per_mtok: numberOrNull(row.output_usd_per_mtok),
      cache_read_reference_usd_per_mtok: numberOrNull(ref?.cache_read_usd_per_mtok),
      cache_write_reference_usd_per_mtok: numberOrNull(ref?.cache_write_usd_per_mtok),
      cache_reference_model_id: ref?.or_id || null,
      cache_reference_match_consistent: ref?.consistent ?? null,
    },
    observed_battle: summary(groups.get(row.model_key) || []),
  };
});
const additional = [...groups.entries()].filter(([name]) => !modelKeys.has(name))
  .map(([model_name, samples]) => ({ model_name, observed_battle: summary(samples) }));
const result = {
  schema: 'arena-model-price-fingerprint-v1',
  generated_at: new Date().toISOString(),
  unit: 'usd_per_million_tokens',
  public_input_output_source: catalog.source,
  public_input_output_fetched_at: catalog.fetched_at,
  public_cache_reference_source: cacheRef.source,
  public_cache_reference_method: cacheRef.method,
  warnings: [
    'published is a quoted/reference price, never an observed Arena charge; the cache reference is an inferred OpenRouter match.',
    'observed_battle rates require usageSource=provider and same-message /cost actual buckets; agent_p50 costs are excluded. Battle does not establish Agent-route prices.',
    'A null rate is unknown or multiple distinct effective rates, not a zero rate. A zero-cost sample is counted separately.',
  ],
  history_entries_seen: historyEntries,
  revealed_battle_sessions_seen: revealedSessions,
  pages_scanned: pages,
  history_complete: complete,
  paired_message_observations: observations.length,
  unpaired_messages_without_actual_cost: unpairedMessages,
  excluded_agent_p50_messages: excludedNonUpstream,
  models,
  additional_observed_models: additional,
  observations,
};
fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ output: outPath, catalog_models: models.length,
  additional_battle_models: additional.length, paired_messages: observations.length,
  published_input: models.filter(m => m.published.input_usd_per_mtok !== null).length,
  published_output: models.filter(m => m.published.output_usd_per_mtok !== null).length,
  published_cache_read: models.filter(m => m.published.cache_read_reference_usd_per_mtok !== null).length,
  published_cache_write: models.filter(m => m.published.cache_write_reference_usd_per_mtok !== null).length,
  exact_observed_input: models.filter(m => m.observed_battle.input.positive_cost_samples).length,
  exact_observed_output: models.filter(m => m.observed_battle.output.positive_cost_samples).length,
  exact_observed_cache_read: models.filter(m => m.observed_battle.cache_read.positive_cost_samples).length,
  exact_observed_cache_write: models.filter(m => m.observed_battle.cache_write.positive_cost_samples).length }));
