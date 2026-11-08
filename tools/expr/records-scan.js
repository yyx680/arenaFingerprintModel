(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const h = await (await fetch('/api/history/unified?limit=6&includeArchived=false', {credentials: 'include'})).json();
  const sid = (h.entries || [])[0].id; out.sid = sid;
  const cj = await (await fetch(`/api/chat/${sid}`, {credentials: 'include'})).json();
  const tok = cj.publicAccessToken || '';
  out.lastEventId = cj.lastEventId;
  out.tokenParts = tok.split('.').length;
  const r = await fetch(`/ai-proxy/realtime/v1/sessions/${sid}/out/records?io=out&afterEventId=0`, { headers: { Authorization: `Bearer ${tok}`, 'x-trigger-source': 'sdk' } });
  const t = await r.text();
  out.recStatus = r.status; out.recLen = t.length;
  out.recHead = t.slice(0, 700);
  out.usageHits = (t.match(/usage|token|cost|credit|settle|charge/gi) || []).slice(0, 20);
  const ph = window.posthog;
  if (ph) {
    out.flags = {};
    for (const k of ['agent-checkpoint-settlement-proof', 'agent-checkpoint-cadence-anchor', 'agent-chat-stream-bootstrap', 'credit-system-m1', 'credit-system-m2']) out.flags[k] = ph.getFeatureFlag ? ph.getFeatureFlag(k) : null;
  }
  return out;
})()
