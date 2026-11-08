(async () => {
  const SID = '01a12c6b-1aef-777b-857e-eeef64cff5c7';
  const r = await fetch('/api/chat/' + SID, {credentials: 'include'});
  const j = await r.json();
  const out = {status: r.status, topKeys: Object.keys(j)};
  const msgs = j.messages || [];
  out.msgCount = msgs.length;
  out.messages = msgs.slice(0, 8).map((m) => {
    const mm = {id: String(m.id || '').slice(0, 12), role: m.role, keys: Object.keys(m), metaKeys: Object.keys(m.metadata || {})};
    for (const k of ['parts', 'content', 'text', 'blocks', 'segments', 'value']) {
      const v = m[k];
      if (Array.isArray(v)) {
        mm[k + '_len'] = v.length;
        mm[k + '_types'] = v.slice(0, 10).map((p) => (p && p.type) || typeof p);
        mm[k + '_keys0'] = v[0] && typeof v[0] === 'object' ? Object.keys(v[0]).slice(0, 12) : null;
      } else if (typeof v === 'string') mm[k + '_strlen'] = v.length;
    }
    return mm;
  });
  const asst = msgs.find((m) => m.role === 'assistant') || msgs[0];
  if (asst) {
    out.asstKeys = Object.keys(asst);
    out.asstSample = JSON.stringify(asst).slice(0, 1500);
  }
  return out;
})()
