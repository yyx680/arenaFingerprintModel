(async () => {
  const urls = [...new Set([...document.scripts].map(s => s.src).filter(u => u.indexOf('/_next/static/chunks/') > -1 && u.indexOf('.js') > -1))];
  const chunks = urls.filter(u => u.indexOf('32a_dgkycyory') > -1 || u.indexOf('2-51xj7gcuh-r') > -1);
  const out = {chunks, segs: []};
  for (const u of chunks) {
    let t = '';
    try { t = await (await fetch(u)).text(); } catch (e) { continue; }
    const short = u.split('/').pop().split('?')[0];
    const idxs = [];
    let re = /\.cost\.\$get|\/cost\b|useCostContext|readCostSnapshot|messageIds/gi, m;
    while ((m = re.exec(t)) !== null) idxs.push(m.index);
    for (const i of idxs.slice(0, 14)) {
      out.segs.push({chunk: short, at: i, ctx: t.slice(Math.max(0, i - 700), i + 500).replace(/\s+/g, ' ').slice(0, 1150)});
    }
  }
  return out;
})()
