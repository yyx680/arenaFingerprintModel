(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const g = async (p) => { try { const x = await fetch(p, {credentials: 'include'}); return {s: x.status, b: (await x.text()).slice(0, 500)}; } catch (e) { return {err: String(e)}; } };
  const out = {url: location.href, host: location.host};
  out.me = await g('/api/me');
  out.pulse = await g('/api/me/pulse');
  let ph = window.posthog;
  for (let i = 0; i < 40 && !(ph && ph.__loaded); i++) { await wait(250); ph = window.posthog; }
  out.hasPH = !!ph;
  if (ph) { out.m1 = ph.getFeatureFlag ? ph.getFeatureFlag('credit-system-m1') : null; out.m2 = ph.getFeatureFlag ? ph.getFeatureFlag('credit-system-m2') : null; out.distinct = ph.get_distinct_id && ph.get_distinct_id(); }
  await wait(1200);
  out.body = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 320);
  return out;
})()
