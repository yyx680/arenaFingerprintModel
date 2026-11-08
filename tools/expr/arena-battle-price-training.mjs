// Export revealed Battle prompts, A/B replies, model labels, and same-message price evidence.
// No Agent/Direct chats, attachments, cookies, public price quotes, or inferred token counts.
// Usage: node tools/expr/arena-battle-price-training.mjs
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const fingerprint = JSON.parse(fs.readFileSync('arena-model-price-fingerprint.json', 'utf8'));
if (fingerprint.schema !== 'arena-model-price-fingerprint-v1' || !fingerprint.history_complete) {
  throw new Error('Build the complete observed price fingerprint first');
}
const catalogKeys = new Set(fingerprint.models.map(m => m.model_key));
const byHash = new Map(fingerprint.observations.map(o => [o.sample_hash, o]));
// Preserve the original prompt and answers of complete one-turn sessions instead of
// refetching unchanged /evaluation responses on each incremental export.
const previous = fs.existsSync('arena-battle-price-training.json')
  ? JSON.parse(fs.readFileSync('arena-battle-price-training.json', 'utf8')) : null;
if (previous && previous.schema !== 'arena-battle-price-training-v1') {
  throw new Error('Existing Battle training set has a different schema');
}
const cachedBattles = new Map((previous?.battles || [])
  .filter(b => b.turns?.length === 1 && b.turns[0].candidates?.length === 2
    && b.turns[0].candidates.every(c => c.price_evidence))
  .map(b => [b.session_id, b]));
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

const battles = [];
let historyEntries = 0;
let cursor = null;
let complete = false;
let pages = 0;
try {
  for (; pages < 8 && !complete; pages += 1) {
    const data = await evaluate(`(${async function (cursor, knownSessions) {
      const alreadyComplete = new Set(knownSessions);
      const qs = new URLSearchParams({ limit: '50', includeArchived: 'false' });
      if (cursor) qs.set('cursor', cursor);
      const response = await fetch('/api/history/unified?' + qs, {
        credentials: 'same-origin', signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) return { error: 'history-' + response.status };
      const history = await response.json();
      const entries = history.entries || [];
      const candidates = entries.filter(e => e?.id && e.type === 'evaluation' && e.mode === 'battle');
      const cached_ids = candidates.filter(e => alreadyComplete.has(e.id)).map(e => e.id);
      const unseen = candidates.filter(e => !alreadyComplete.has(e.id));
      const rows = [];
      const errors = [];
      let index = 0;
      async function worker() {
        while (index < unseen.length) {
          const entry = unseen[index++];
          try {
            const r = await fetch('/api/evaluation/' + entry.id, {
              credentials: 'same-origin', signal: AbortSignal.timeout(20000),
            });
            if (!r.ok) { errors.push('evaluation-' + r.status); continue; }
            const evaluation = await r.json();
            if (evaluation.mode !== 'battle' || !evaluation.revealedModels?.length) continue;
            const names = new Map(evaluation.revealedModels.map(m => [m.id, m]));
            const messages = evaluation.messages || [];
            const textContent = content => {
              if (typeof content === 'string') return content;
              if (Array.isArray(content)) {
                const visible = content.filter(part =>
                  part?.type === 'text' && typeof part.text === 'string');
                return visible.length ? visible.map(part => part.text).join('\n') : null;
              }
              return null;
            };
            const userMessages = new Map(messages.filter(m => m.role === 'user')
              .map(m => [m.id, m]));
            const turns = new Map();
            for (const u of userMessages.values()) {
              turns.set(u.id, {
                prompt_message_id: u.id, prompt: textContent(u.content),
                prompt_has_attachments: !!u.experimental_attachments?.length,
                prompt_has_non_text_parts: Array.isArray(u.content)
                  && u.content.some(part => part?.type !== 'text'),
                created_at: u.createdAt || null,
                candidates: [],
              });
            }
            const unlinked = [];
            for (const m of messages) {
              if (m.role !== 'assistant' || !names.has(m.modelId)) continue;
              const model = names.get(m.modelId);
              const parentUserId = (m.parentMessageIds || []).find(id => userMessages.has(id));
              const answer = {
                message_id: m.id, participant_position: m.participantPosition,
                model_id: m.modelId, model_name: model.displayName || model.publicName,
                model_provider: model.provider || null,
                response: textContent(m.content),
                response_has_attachments: !!m.experimental_attachments?.length,
                response_has_non_text_parts: Array.isArray(m.content)
                  && m.content.some(part => part?.type !== 'text'),
                status: m.status || null, created_at: m.createdAt || null,
                usage: m.metadata?.usage || null,
              };
              if (parentUserId) turns.get(parentUserId).candidates.push(answer);
              else unlinked.push(answer);
            }
            rows.push({ session_id: entry.id,
              turns: [...turns.values()].filter(turn => turn.candidates.length), unlinked });
          } catch (error) { errors.push('evaluation-' + String(error).slice(0, 80)); }
        }
      }
      await Promise.all([worker(), worker()]);
      return { entries: entries.length, rows, cached_ids, errors,
        has_more: history.pagination?.hasMore === true,
        next_cursor: history.pagination?.cursor || null };
    }})(${JSON.stringify(cursor)}, ${JSON.stringify([...cachedBattles.keys()])})`);
    if (!data || data.error) throw new Error(data?.error || 'Empty history page');
    if (data.errors.length) throw new Error('History/evaluation errors: ' + data.errors.slice(0, 5).join(', '));
    battles.push(...data.rows, ...data.cached_ids.map(id => cachedBattles.get(id)));
    historyEntries += data.entries;
    complete = !data.has_more;
    cursor = data.next_cursor;
    if (data.has_more && !cursor) throw new Error('History cursor missing');
    console.log(JSON.stringify({ page: pages + 1, entries: data.entries,
      revealed_battles: data.rows.length, has_more: data.has_more }));
  }
} finally { ws.close(); }
if (!complete) throw new Error('History still has more pages; no output written');

let paired = 0;
let missingCost = 0;
let unlinked = 0;
const distinctModels = new Set();
const exactCatalogModels = new Set();
for (const battle of battles) {
  for (const turn of battle.turns) {
    for (const candidate of turn.candidates) {
      const sampleHash = hash(battle.session_id, candidate.message_id);
      const evidence = byHash.get(sampleHash);
      candidate.sample_hash = sampleHash;
      candidate.price_evidence = evidence ? {
        cost_source: evidence.cost_source,
        usage_source: evidence.usage_source,
        actual_total_cost_usd: evidence.actual_total_cost_usd,
        components: evidence.components,
      } : null;
      if (evidence) paired += 1;
      else missingCost += 1;
      distinctModels.add(candidate.model_name);
      if (catalogKeys.has(candidate.model_name)) exactCatalogModels.add(candidate.model_name);
    }
  }
  for (const candidate of battle.unlinked) {
    candidate.sample_hash = hash(battle.session_id, candidate.message_id);
    candidate.price_evidence = null;
    unlinked += 1;
  }
}
const out = {
  schema: 'arena-battle-price-training-v1',
  generated_at: new Date().toISOString(),
  source: 'This account\'s revealed Arena Battle evaluation messages; actual buckets paired through arena-model-price-fingerprint.json',
  price_fingerprint_generated_at: fingerprint.generated_at,
  note: 'Each turn uses the SAME user prompt for its A/B candidates; different Battle turns can have different prompts. Model names are revealed labels, not inferred from response text. No public quote is treated as measured.',
  unit: 'usd_per_million_tokens',
  history_entries_seen: historyEntries,
  history_complete: complete,
  revealed_battles: battles.length,
  paired_assistant_messages: paired,
  assistant_messages_without_cost_pair: missingCost,
  unlinked_assistant_messages: unlinked,
  distinct_revealed_model_names: distinctModels.size,
  exact_catalog_model_names: exactCatalogModels.size,
  battles,
};
fs.writeFileSync('arena-battle-price-training.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ output: 'arena-battle-price-training.json',
  battles: battles.length, paired_assistant_messages: paired,
  without_cost_pair: missingCost, unlinked_assistant_messages: unlinked,
  distinct_revealed_model_names: distinctModels.size,
  exact_catalog_model_names: exactCatalogModels.size }));
