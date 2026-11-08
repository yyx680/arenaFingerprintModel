// Read-only Battle cost/usage probe using the extension's temporary PostHog cost flag.
// Run only against Arena sessions owned by the current logged-in browser profile.
// Prints only revealed model names, provider usage and cost buckets; never prints cookies or text.
const ids = process.argv.slice(2).filter(id => /^[0-9a-f-]{30,40}$/i.test(id)).slice(0, 5);
if (!ids.length) throw new Error('Supply 1–5 Battle session IDs');
const targets = await fetch('http://127.0.0.1:9333/json/list').then(r => r.json());
const page = targets.find(p => p.type === 'page' && p.url.startsWith('https://arena.ai/'));
if (!page) throw new Error('Open arena.ai in the dedicated Chrome window first');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
const expression = `(${async function (ids) {
  const flagKey = 'ph-toolbar-overrides';
  const flagValue = JSON.stringify({ 'credit-system-m1': 'cost-shown' });
  const existing = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith(flagKey + '='));
  let prior = null;
  try { if (existing) prior = decodeURIComponent(existing.slice(flagKey.length + 1)); } catch {}
  if (existing && prior !== flagValue) return { error: 'A different PostHog override already exists; left untouched.' };
  let temporary = false;
  if (!existing) {
    document.cookie = flagKey + '=' + encodeURIComponent(flagValue) + '; Path=/; Max-Age=60; SameSite=Lax; Secure';
    temporary = true;
  }
  const out = [];
  let cleared = null;
  try {
    for (const id of ids) {
      const row = { battle: id };
      try {
        const [er, cr] = await Promise.all([
          fetch('/api/evaluation/' + id, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) }),
          fetch('/api/evaluation/' + id + '/cost', { credentials: 'same-origin', signal: AbortSignal.timeout(15000) }),
        ]);
        row.evaluationStatus = er.status;
        row.costStatus = cr.status;
        if (er.ok) {
          const evaluation = await er.json();
          const names = new Map((evaluation.revealedModels || []).map(model => [model.id, model.displayName || model.publicName]));
          row.revealed = names.size;
          const costs = cr.ok ? (await cr.json()) : null;
          const byMessage = costs?.messages || {};
          row.sessionCost = costs?.session?.aggregate?.actual?.totalCostUsd ?? null;
          row.pairs = (evaluation.messages || []).filter(m => m.role === 'assistant' && names.has(m.modelId)).map(m => {
            const actual = byMessage[m.id]?.actual;
            return {
              model: names.get(m.modelId),
              position: m.participantPosition,
              usage: m.metadata?.usage || null,
              cost: actual ? {
                source: actual.source,
                total: actual.totalCostUsd,
                input: actual.inputTokensCostUsd,
                output: actual.outputTokensCostUsd,
                cacheRead: actual.cacheReadTokensCostUsd,
                cacheWrite: actual.cacheWriteTokensCostUsd,
              } : null,
            };
          });
        }
      } catch (error) { row.error = String(error).slice(0, 90); }
      out.push(row);
    }
  } finally {
    if (temporary) {
      document.cookie = flagKey + '=; Path=/; Max-Age=0; SameSite=Lax; Secure';
      cleared = !document.cookie.split(';').some(x => x.trim().startsWith(flagKey + '='));
    }
  }
  return { results: out, temporaryOverrideCleared: cleared };
}})(${JSON.stringify(ids)})`;
const result = await new Promise((resolve, reject) => {
  ws.addEventListener('message', e => {
    const data = JSON.parse(e.data);
    if (data.id !== 1) return;
    data.error ? reject(data.error) : resolve(data.result);
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
});
ws.close();
if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
console.log(JSON.stringify(result.result?.value));
