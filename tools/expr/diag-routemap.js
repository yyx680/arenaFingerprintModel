(async () => {
  const urls = [...new Set([...document.scripts].map(s => s.src).filter(u => u.indexOf('/_next/static/chunks/') > -1 && u.indexOf('.js') > -1))];
  const calls = new Map();
  const PAT = /api(?:\.[A-Za-z0-9_]+|\[[^\]]{0,30}\])+\.\$(?:get|post|put|patch|delete)/g;
  for (const u of urls) {
    let text = '';
    try { text = await (await fetch(u)).text(); } catch { continue; }
    const name = u.split('/').pop().split('?')[0].slice(0, 30);
    let m; PAT.lastIndex = 0;
    while ((m = PAT.exec(text)) !== null) {
      const norm = m[0].replace(/\[[^\]]{0,30}\]/g, '[:x]');
      if (!calls.has(norm)) calls.set(norm, name);
    }
  }
  const list = [...calls.entries()].map(([call, chunk]) => ({call, chunk}));
  const byNs = {};
  for (const c of list) {
    const ns = (c.call.slice(4).split('.')[0] || '?').replace(/\[.*/, '');
    (byNs[ns] = byNs[ns] || []).push(c.call + '  [' + c.chunk + ']');
  }
  const RE = /cost|credit|billing|price|payment|invoice|subscription|plan|usage|quota|balance|topup|margin|spend|wallet|ledger|purchase|entitlement/i;
  const interesting = list.filter((x) => RE.test(x.call)).map((x) => x.call + '  [' + x.chunk + ']');
  return {total_routes: list.length, namespaces: Object.fromEntries(Object.entries(byNs).map(([k, v]) => [k, v.length])), interesting, byNs};
})()
