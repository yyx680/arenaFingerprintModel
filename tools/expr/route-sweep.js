(async () => {
  const h = await (await fetch('/api/history/unified?limit=3&includeArchived=false', {credentials: 'include'})).json();
  const sid = (h.entries || [])[0].id;
  const cj = await (await fetch(`/api/chat/${sid}`, {credentials: 'include'})).json();
  const aid = cj.triggerAddress || sid;
  const out = {sid, aid, hits: [], total: 0};
  const pres = ['/api/chat/' + sid, '/api/agent-logs/' + aid, '/api/coding-agent/sessions/' + sid, '/api/agent-sessions/' + sid, '/api/agents/' + sid, '/api/sessions/' + sid, '/api/me', '/api/v2'];
  const sufs = ['', '/usage', '/usage/records', '/usages', '/cost', '/costs', '/cost-breakdown', '/breakdown', '/tokens', '/token-usage', '/usage-summary', '/summary', '/stats', '/statistics', '/metrics', '/analytics', '/transcript', '/transcripts', '/export', '/share', '/logs', '/events', '/receipts', '/receipt', '/checkpoints', '/settlements', '/settlement', '/billing', '/balance', '/credits', '/quota', '/limits', '/entitlements', '/ledger', '/wallet', '/invoices', '/messages', '/turns', '/runs', '/status', '/info', '/details', '/metadata', '/model-usage', '/models', '/price', '/pricing', '/charge', '/charges', '/spend', '/spending'];
  const urls = [];
  for (const p of pres) for (const s of sufs) urls.push(p + s);
  const seen = new Set(); const list = urls.filter((u) => !seen.has(u) && seen.add(u));
  const workers = Array.from({length: 10}, async () => {
    while (list.length) {
      const u = list.shift();
      try {
        const r = await fetch(u, {credentials: 'include'});
        const t = await r.text(); out.total++;
        if (!(r.status === 403 && /Route not allowed/.test(t))) out.hits.push({u, s: r.status, b: t.slice(0, 100)});
      } catch (e) { }
    }
  });
  await Promise.all(workers);
  return out;
})()
