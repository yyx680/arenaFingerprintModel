(async () => {
  const sid = '01a12c6b-1aef-777b-857e-eeef64cff5c7';
  const j = await fetch('/api/chat/' + sid, {credentials: 'include'}).then((r) => r.json()).catch(() => null);
  const tok = j && j.publicAccessToken;
  let rec = null;
  try {
    const r1 = await fetch('/ai-proxy/realtime/v1/sessions/' + sid + '/out/records?io=out&afterEventId=0', {headers: {'Authorization': 'Bearer ' + tok, 'x-trigger-source': 'sdk'}});
    const jj = await r1.json();
    const recs = jj.records || [];
    const types = recs.map((x) => { let b = x.data; if (typeof b === 'string') { try { b = JSON.parse(b); } catch {} } if (b && typeof b === 'object' && typeof b.body === 'string') { try { b.body = JSON.parse(b.body); } catch {} } return (b && (b.type || (b.body && b.body.type))) || '?'; });
    const s = JSON.stringify(recs);
    rec = {status: r1.status, count: recs.length, types, usageHits: (s.match(/usage|promptTokens|cacheRead|totalCost/gi) || []).slice(0, 8)};
  } catch (e) { rec = {err: String(e)}; }
  const bucket = (document.cookie.match(/arena_build_bucket=([^;]+)/) || [])[1] || null;
  let flags = null;
  try { flags = window.posthog && (window.posthog.featureFlags && window.posthog.featureFlags.getFlags ? window.posthog.featureFlags.getFlags() : null); } catch (e) { flags = 'err:' + e; }
  let flagNames = null;
  try { const all = window.posthog && window.posthog.featureFlags && window.posthog.featureFlags.getFlagVariants && window.posthog.featureFlags.getFlagVariants(); flagNames = all ? Object.keys(all).slice(0, 60) : null; } catch (e) { flagNames = 'err:' + e; }
  return {chatKeys: j ? Object.keys(j) : null, rec, bucket, flags, flagNames};
})()
