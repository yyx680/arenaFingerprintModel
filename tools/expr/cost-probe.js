(async () => {
  const m = location.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  const sid = m ? m[0] : '01a12c62-cf51-7a74-be5c-3108fe89af0f';
  const out = {host: location.host, sid, tests: []};
  const g = async (u) => { try { const r = await fetch(u, {credentials: 'include'}); const t = await r.text(); out.tests.push([u.replace('/api/', ''), r.status, t.slice(0, 160)]); } catch (e) { out.tests.push([u, 'ERR', String(e).slice(0, 80)]); } };
  await g('/api/chat/' + sid + '/cost?includeSession=true');
  await g('/api/chat/' + sid + '/cost?includeSession=false');
  await g('/api/chat/' + sid + '/cost');
  await g('/api/evaluation/' + sid + '/cost');
  const me = await fetch('/api/me', {credentials: 'include'}).then((r) => r.json()).catch(() => null);
  out.me = me && me.user ? me.user.id : null;
  out.flags = {};
  for (const f of ['credit-system-m1', 'credit-system-m2', 'portal_enable_billing_topups', 'video-image-pricedata']) {
    try { out.flags[f] = window.posthog && window.posthog.getFeatureFlag ? window.posthog.getFeatureFlag(f) : 'no-posthog'; } catch (e) { out.flags[f] = 'err'; }
  }
  return out;
})()
