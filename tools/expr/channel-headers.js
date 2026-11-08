(async () => {
  const h = await (await fetch('/api/history/unified?limit=3&includeArchived=false', {credentials: 'include'})).json();
  const sid = (h.entries || [])[0].id;
  const cj = await (await fetch(`/api/chat/${sid}`, {credentials: 'include'})).json();
  const tok = cj.publicAccessToken || '';
  const out = {sid, results: []};
  const hdrSets = {
    none: {},
    sdk: {'x-trigger-source': 'sdk'},
    kiro: {'x-trigger-source': 'kiro', 'x-arena-client': 'kiro', 'x-arena-channel': 'kiro', 'x-arena-integration': 'kiro', 'x-client': 'kiro', 'x-source': 'kiro'},
    bucketCanary: {'x-arena-build-bucket': 'canary'},
    cli: {'x-arena-client': 'cli', 'x-arena-channel': 'cli', 'user-agent': 'arena-cli/1.0'},
    bearer: {Authorization: `Bearer ${tok}`},
    m2m: {'x-arena-m2m-token': tok, 'x-m2m-token': tok},
  };
  const urls = [
    {method: 'POST', url: `/api/agent-logs/${sid}/usage`, body: '{}'},
    {method: 'GET', url: '/api/coding-agent/sessions'},
    {method: 'GET', url: `/api/coding-agent/sessions/${sid}/workflow-checks`},
  ];
  for (const [name, hh] of Object.entries(hdrSets)) {
    for (const u of urls) {
      try {
        const r = await fetch(u.url, {method: u.method, credentials: 'include', headers: Object.assign({'Content-Type': 'application/json'}, hh), body: u.body});
        const t = await r.text();
        out.results.push({name, url: u.url, s: r.status, b: t.slice(0, 120)});
      } catch (e) { out.results.push({name, url: u.url, err: String(e).slice(0, 80)}); }
    }
  }
  const uniq = {};
  for (const x of out.results) { const k = `${x.s}|${(x.b || x.err || '').slice(0, 60)}`; uniq[k] = (uniq[k] || 0) + 1; }
  out.summary = uniq;
  out.notable = out.results.filter((x) => x.s && x.s !== 403);
  return out;
})()
