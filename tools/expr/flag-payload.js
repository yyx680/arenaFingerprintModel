(() => {
  const ph = window.posthog;
  if (!ph || !ph.featureFlags || !ph.featureFlags.getFlagVariants) return {err: 'no posthog'};
  const vars = ph.featureFlags.getFlagVariants();
  const out = {host: location.host, picked: {}};
  const keys = Object.keys(vars).filter((k) => /credit|billing|portal|topup|top-up|purchase|upgrade|plan|trial|pay/i.test(k));
  for (const k of keys) {
    let payload = null;
    try { payload = ph.getFeatureFlagPayload ? ph.getFeatureFlagPayload(k) : null; } catch (e) {}
    out.picked[k] = {value: vars[k], payload};
  }
  return out;
})()
