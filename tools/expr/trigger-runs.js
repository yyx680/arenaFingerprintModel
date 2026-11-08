(async () => {
  const h = await (await fetch('/api/history/unified?limit=6&includeArchived=false', {credentials: 'include'})).json();
  const sid = (h.entries || [])[0].id;
  const cj = await (await fetch(`/api/chat/${sid}`, {credentials: 'include'})).json();
  const tok = cj.publicAccessToken || '';
  const aid = cj.triggerAddress || sid;
  const out = {sid, aid, runs: []};
  const paths = [
    `/ai-proxy/realtime/v1/runs/${aid}`,
    `/ai-proxy/realtime/v1/runs/${aid}?skipColumns=payload`,
    `/ai-proxy/realtime/v1/runs/${sid}`,
    `/ai-proxy/api/v1/runs/${aid}`, `/ai-proxy/api/v3/runs/${aid}`, `/ai-proxy/v1/runs/${aid}`, `/ai-proxy/v3/runs/${aid}`,
    `/ai-proxy/realtime/v1/sessions/${sid}`, `/ai-proxy/realtime/v1/streams/${aid}`,
    `/ai-proxy/api/v1/runs`, `/ai-proxy/realtime/v1/runs`,
  ];
  for (const p of paths) {
    for (const [name, hh] of [['bearer', {Authorization: `Bearer ${tok}`}], ['cookie', {}]]) {
      try {
        const r = await fetch(p, {credentials: 'include', headers: Object.assign({'x-trigger-source': 'sdk'}, hh)});
        const t = await r.text();
        out.runs.push({p, name, s: r.status, len: t.length,
          hasUsage: /"usage"|inputTokens|outputTokens|costInCents|"cost"/.test(t),
          head: t.slice(0, 220)});
      } catch (e) { out.runs.push({p, name, err: String(e).slice(0, 60)}); }
    }
  }
  return out;
})()
