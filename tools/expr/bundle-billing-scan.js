(async () => {
  const urls = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => /_next\/static\/.*\.js/.test(u));
  const out = {scripts: urls.length, portal: [], topup: [], credit: [], checkout: []};
  const grab = (t, re, key, u, max) => {
    let m, c = 0;
    re.lastIndex = 0;
    while ((m = re.exec(t)) && c < max) {
      out[key].push(u.split('/').pop() + ' :: ' + t.slice(Math.max(0, m.index - 110), m.index + 130).replace(/\s+/g, ' '));
      c += 1;
    }
  };
  for (const u of urls) {
    let t = '';
    try { t = await (await fetch(u)).text(); } catch { continue; }
    grab(t, /portal_enable_billing_topups/g, 'portal', u, 3);
    grab(t, /top-?up/gi, 'topup', u, 3);
    grab(t, /credit-system-m[12]/g, 'credit', u, 2);
    grab(t, /stripe|checkout\.stripe|billing\/portal|create-checkout/gi, 'checkout', u, 3);
  }
  return out;
})()
