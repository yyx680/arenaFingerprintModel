(async () => {
  const h = await (await fetch('/api/history/unified?limit=6&includeArchived=false', {credentials: 'include'})).json();
  const sid = (h.entries || [])[0]?.id;
  const chat = await (await fetch('/api/chat/' + sid, {credentials: 'include'})).json();
  const token = chat.publicAccessToken || null;
  const lastMsg = (chat.messages || []).slice(-1)[0]?.id || null;
  const base = '/api/chat/' + sid + '/cost';
  const combos = [
    ['baseline', base + '?includeSession=true', {}],
    ['caller-ssr', base + '?includeSession=true', {'x-arena-request-caller': 'web-ssr-public'}],
    ['caller-cachefill', base + '?includeSession=true', {'x-arena-request-caller': 'web_ssr_cache_fill'}],
    ['bucket-canary', base + '?includeSession=true', {'x-arena-build-bucket': 'canary'}],
    ['rsc', base + '?includeSession=true', {'RSC': '1'}],
    ['bearer-public', base + '?includeSession=true', token ? {'authorization': 'Bearer ' + token} : {}],
    ['msgids', base + '?includeSession=false&messageIds=' + lastMsg, {}],
    ['combo', base + '?includeSession=true', Object.assign({'x-arena-request-caller': 'web-ssr-public', 'x-arena-build-bucket': 'canary', 'RSC': '1'}, token ? {'authorization': 'Bearer ' + token} : {})],
    ['waf-empty', base + '?includeSession=true', {'x-api-waf-token': 'x'}],
  ];
  const out = {sid, has_token: !!token, results: []};
  for (const [name, url, headers] of combos) {
    try {
      const r = await fetch(url, {credentials: 'include', headers});
      const text = await r.text();
      out.results.push({
        name,
        status: r.status,
        body: text.slice(0, 200),
        h: {
          refresh: r.headers.get('x-arena-refresh-required'),
          deploy: r.headers.get('x-arena-api-deployment') || r.headers.get('x-arena-web-deployment'),
          auth: r.headers.get('www-authenticate'),
          ct: r.headers.get('content-type'),
        },
      });
    } catch (error) {
      out.results.push({name, error: String(error?.message || error)});
    }
  }
  return out;
})()
