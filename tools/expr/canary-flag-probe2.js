(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const safe = (f) => { try { return f(); } catch (e) { return 'ERR:' + e; } };
  const out = {};
  for (let i = 0; i < 60; i++) { if (location.host && location.host.includes('arena')) break; await wait(250); }
  out.url = location.href; out.origin = safe(() => location.origin); out.readyState = document.readyState;
  out.dpl = safe(() => document.documentElement.dataset.dplId || null);
  out.bucketCookie = safe(() => (document.cookie.match(/arena_build_bucket=([^;]+)/) || [])[1] || null);
  let ph = window.posthog;
  for (let i = 0; i < 60 && !(ph && ph.__loaded); i++) { await wait(250); ph = window.posthog; }
  out.hasPH = !!ph;
  if (ph) {
    out.m1 = safe(() => ph.getFeatureFlag('credit-system-m1')); out.m2 = safe(() => ph.getFeatureFlag('credit-system-m2'));
    const ff = safe(() => (ph.getFeatureFlags ? ph.getFeatureFlags() : null));
    if (ff && typeof ff === 'object') { out.flagCount = Object.keys(ff).length;
      out.creditFlags = Object.fromEntries(Object.entries(ff).filter(([k]) => /credit|cost|billing|topup|portal/i.test(k))); }
    out.distinct = safe(() => ph.get_distinct_id());
    out.canaryProp = safe(() => ph.get_property('canary')); out.envProp = safe(() => ph.get_property('env'));
  }
  out.bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 240);
  return out;
})()
