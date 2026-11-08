(async () => {
  const ph = window.posthog;
  const id = ph && ph.get_distinct_id ? ph.get_distinct_id() : null;
  const out = {distinct_id: id};
  const body = {token: 'phc_LG7IJbVJqBsk584rbcKca0D5lV2vHguiijDrVji7yDM', distinct_id: id, groups: {}, person_properties: {}};
  try {
    const r = await fetch('https://us.i.posthog.com/flags/?v=2', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const j = await r.json();
    const flags = j.flags || j.featureFlags || {};
    out.status = r.status;
    out.topKeys = Object.keys(j);
    out.flagCount = Object.keys(flags).length;
    out.picked = {};
    for (const k of ['credit-system-m1', 'credit-system-m2', 'portal_enable_billing_topups']) out.picked[k] = flags[k] || null;
    out.related = Object.keys(flags).filter((k) => /credit|cost|billing|portal|topup/i.test(k)).map((k) => k + '=' + JSON.stringify(flags[k]));
    out.errors = j.errorsWhileComputingFlags;
  } catch (e) { out.err = String(e); }
  return out;
})()
