(async () => {
  const h = await (await fetch('/api/history/unified?limit=8&includeArchived=false', {credentials: 'include'})).json();
  const sid = (h.entries || [])[0].id;
  const cj = await (await fetch(`/api/chat/${sid}`, {credentials: 'include'})).json();
  const tok = cj.publicAccessToken || '';
  const out = {sid, list: []};
  const qs = [
    `/ai-proxy/realtime/v1/runs?tasks=chat-agent`,
    `/ai-proxy/realtime/v1/runs?tags=${sid}`,
    `/ai-proxy/realtime/v1/runs?tags=chat-agent`,
    `/ai-proxy/realtime/v1/runs?tags=arena`,
    `/ai-proxy/realtime/v1/runs?skipColumns=payload`,
    `/ai-proxy/realtime/v1/runs?tasks=chat-agent&skipColumns=payload`,
  ];
  for (const p of qs) {
    try {
      const r = await fetch(p, {credentials: 'include', headers: {Authorization: `Bearer ${tok}`, Accept: 'text/event-stream, application/json'}});
      const t = await r.text();
      out.list.push({p, s: r.status, len: t.length, hasUsage: /usage|inputTokens|costInCents|"cost"/.test(t), head: t.slice(0, 300)});
    } catch (e) { out.list.push({p, err: String(e).slice(0, 80)}); }
  }
  return out;
})()
