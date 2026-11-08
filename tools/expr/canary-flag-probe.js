(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {url: location.href, host: location.host, dpl: document.documentElement.dataset.dplId || null};
  out.bucketCookie = (document.cookie.match(/arena_build_bucket=([^;]+)/) || [])[1] || null;
  let ph = window.posthog;
  for (let i = 0; i < 40 && !(ph && ph.__loaded); i++) { await wait(250); ph = window.posthog; }
  out.hasPH = !!ph;
  if (ph) {
    try { out.m1 = ph.getFeatureFlag('credit-system-m1'); out.m2 = ph.getFeatureFlag('credit-system-m2'); } catch (e) { out.flagErr = String(e); }
    try { const ff = ph.getFeatureFlags && ph.getFeatureFlags(); out.flagCount = ff ? Object.keys(ff).length : null;
      out.creditFlags = ff ? Object.fromEntries(Object.entries(ff).filter(([k]) => /credit|cost|billing|topup|portal/i.test(k))) : null; } catch (e) { out.ffErr = String(e); }
    try { out.distinct = ph.get_distinct_id(); } catch {}
    try { out.canaryProp = ph.get_property && ph.get_property('canary'); } catch {}
    try { out.envProp = ph.get_property && ph.get_property('env'); } catch {}
  }
  out.bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 260);
  return out;
})()
