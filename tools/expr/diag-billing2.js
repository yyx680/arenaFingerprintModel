(async () => {
  const out = {};
  const urls = [...new Set([...document.scripts].map((s) => s.src).filter((u) => u.indexOf('/_next/static/chunks/') > -1 && u.indexOf('.js') > -1))];
  out.chunks = urls.length;
  const paths = new Set();
  const flags = new Set();
  const hits = [];
  const RE = /\/((settings|account|billing|credits|pricing|plans|upgrade|portal)[A-Za-z0-9_\-\/]{0,40})/g;
  const FLAGWORDS = ['portal_enable_billing_topups', 'enable_billing', 'billingEnabled', 'showBilling', 'creditsEnabled', 'costDisplay', 'topup'];
  const NEEDLES = ['stripe', 'portalUrl', 'billingPortal'];
  for (const u of urls) {
    let t = '';
    try { t = await (await fetch(u)).text(); } catch (e) { continue; }
    const name = u.split('/').pop().split('?')[0].slice(0, 24);
    let m; RE.lastIndex = 0;
    let c = 0;
    while ((m = RE.exec(t)) !== null) { paths.add('/' + m[1].slice(0, 50)); if (++c > 6) break; }
    for (const f of FLAGWORDS) { if (t.indexOf(f) > -1) flags.add(f + '  [' + name + ']'); }
    for (const nd of NEEDLES) { let pi = t.indexOf(nd); let pc = 0; while (pi > -1 && pc < 2) { hits.push(t.slice(Math.max(0, pi - 30), pi + 70).replace(/\s+/g, ' ').slice(0, 100) + '  [' + name + ']'); pi = t.indexOf(nd, pi + 1); pc++; } }
  }
  out.paths = [...paths].slice(0, 30);
  out.flags = [...flags].slice(0, 20);
  out.hits = [...new Set(hits)].slice(0, 15);
  return out;
})()
