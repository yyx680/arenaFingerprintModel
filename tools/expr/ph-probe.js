(async () => {
  const out = {host: location.host};
  const ph = window.posthog;
  if (!ph) return {err: 'no posthog'};
  out.distinct_id = ph.get_distinct_id ? ph.get_distinct_id() : null;
  const props = ['$initial_current_url', '$initial_referrer', '$initial_referring_domain', '$host', '$current_url', '$device_id'];
  out.props = {};
  for (const p of props) { try { out.props[p] = ph.get_property ? ph.get_property(p) : null; } catch (e) { out.props[p] = 'err:' + e; } }
  try { out.freshFlag = ph.getFeatureFlag ? ph.getFeatureFlag('credit-system-m1') : null; } catch (e) { out.freshFlag = 'err'; }
  try { out.flagResult = ph.getFeatureFlagResult ? JSON.stringify(ph.getFeatureFlagResult('credit-system-m1')) : 'n/a'; } catch (e) { out.flagResult = 'err:' + e; }
  try {
    const r = await fetch('https://us.i.posthog.com/decide/?v=3', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: 'phc_LG7IJbVJqBsk584rbcKca0D5lV2vHguiijDrVji7yDM', distinct_id: out.distinct_id, groups: {}, person_properties: {}})
    });
    const j = await r.json();
    const ff = j.featureFlags || {};
    out.decide = {
      status: r.status, count: Object.keys(ff).length,
      credit: {m1: ff['credit-system-m1'], m2: ff['credit-system-m2']},
      related: Object.keys(ff).filter((k) => /credit|cost|billing|portal|topup/i.test(k)).map((k) => k + '=' + JSON.stringify(ff[k])).slice(0, 20),
      errors: j.errorsWhileComputingFlags
    };
  } catch (e) { out.decide = {err: String(e)}; }
  return out;
})()
