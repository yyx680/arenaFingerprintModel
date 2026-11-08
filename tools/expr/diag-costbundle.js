(async () => {
  const urls = [...new Set([...document.scripts].map(s => s.src).filter(u => u.indexOf('/_next/static/chunks/') > -1 && u.indexOf('.js') > -1))];
  const flags = new Set(), costCalls = new Set(), toolbarCtx = [], enumCtx = [];
  for (const u of urls) {
    let t = '';
    try { t = await (await fetch(u)).text(); } catch (e) { continue; }
    const short = u.split('/').pop().split('?')[0].slice(0, 26);
    let m, re1 = /credit-system[a-z0-9_.-]*/gi, re2 = /\.cost\.\$get|\/cost\b/gi;
    while ((m = re1.exec(t)) !== null) { flags.add(m[0]); if (flags.size > 40) break; }
    let c2 = 0;
    while ((m = re2.exec(t)) !== null) { costCalls.add(short + ' :: ' + m[0]); if (++c2 > 3) break; }
    let i = t.indexOf('ph-toolbar-overrides');
    while (i >= 0 && toolbarCtx.length < 5) {
      toolbarCtx.push({chunk: short, ctx: t.slice(Math.max(0, i - 260), i + 260).replace(/\s+/g, ' ').slice(0, 520)});
      i = t.indexOf('ph-toolbar-overrides', i + 1);
    }
    let j = t.indexOf('credit-system-m1');
    while (j >= 0 && enumCtx.length < 6) {
      enumCtx.push({chunk: short, ctx: t.slice(Math.max(0, j - 200), j + 260).replace(/\s+/g, ' ').slice(0, 460)});
      j = t.indexOf('credit-system-m1', j + 1);
    }
  }
  return {chunks: urls.length, flags: [...flags], costCalls: [...costCalls].slice(0, 20), toolbarCtx, enumCtx};
})()
