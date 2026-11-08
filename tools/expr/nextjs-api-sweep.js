(async () => {
  const h = await (await fetch('/api/history/unified?limit=3&includeArchived=false', {credentials: 'include'})).json();
  const sid = (h.entries || [])[0].id;
  const out = {sid, hits: [], total: 0};
  const names = ['cost', 'costs', 'usage', 'usages', 'tokens', 'token-usage', 'session', 'sessions', 'chat', 'chats', 'agent', 'agent-logs', 'agent-log', 'agents', 'logs', 'log', 'billing', 'credits', 'credit', 'balance', 'plan', 'plans', 'me', 'user', 'users', 'account', 'quota', 'limits', 'spend', 'ledger', 'stats', 'analytics', 'metrics', 'transcript', 'export', 'history', 'workspace', 'workspaces', 'models', 'model-catalog', 'auto-modality', 'price', 'pricing', 'settlement', 'settlements', 'checkpoint', 'checkpoints', 'receipt', 'receipts', 'invoice', 'invoices', 'subscription', 'entitlements', 'entitlement'];
  const urls = [];
  for (const n of names) { urls.push(`/nextjs-api/${n}`); urls.push(`/nextjs-api/${n}?sessionId=${sid}`); urls.push(`/nextjs-api/${n}/${sid}`); }
  const workers = Array.from({length: 10}, async () => {
    while (urls.length) {
      const u = urls.shift();
      try { const r = await fetch(u, {credentials: 'include'}); const t = await r.text(); out.total++;
        if (r.status !== 404) out.hits.push({u, s: r.status, b: t.slice(0, 140)});
      } catch (e) {}
    }
  });
  await Promise.all(workers);
  return out;
})()
