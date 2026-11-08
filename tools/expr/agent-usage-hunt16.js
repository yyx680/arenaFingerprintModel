// Deep-inventory the realtime /out event log (JSON snapshot + arrays), for the just-finished run.
const sid = '01a12c3d-4498-7388-ae9c-17071b92e823';
const out = { tries: [] };
const urls = [
  '/ai-proxy/realtime/v1/sessions/' + sid + '/out',
  '/ai-proxy/realtime/v1/sessions/' + sid + '/out?tail=0',
];
for (const u of urls) {
  try {
    const resp = await fetch(u, { credentials: 'include' });
    const t = await resp.text();
    const rec = { u: u.split('?')[1] || 'plain', status: resp.status, len: t.length };
    // try JSON first
    let j = null; try { j = JSON.parse(t); } catch {}
    if (j) {
      rec.topKeys = Object.keys(j);
      rec.tail = j.tail; rec.seq_num = j.seq_num;
      rec.recordCount = Array.isArray(j.records) ? j.records.length : null;
      const keys = new Map(); // key -> count
      const walk = (v, depth) => {
        if (depth > 7 || !v || typeof v !== 'object') return;
        const entries = Array.isArray(v) ? v.slice(0, 40) : Object.entries(v);
        if (Array.isArray(v)) { for (const item of entries) walk(item, depth + 1); return; }
        for (const [k, val] of Object.entries(v)) {
          keys.set(k, (keys.get(k) || 0) + 1);
          if (val && typeof val === 'object') walk(val, depth + 1);
        }
      };
      if (Array.isArray(j.records)) for (const r of j.records.slice(0, 60)) walk(r, 0);
      rec.allKeys = [...keys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 120).map(([k, c]) => k + ':' + c);
      // suspicious metering-ish keys full list
      rec.suspicious = [...keys.keys()].filter(k => /usag|token|cost|credit|price|spend|bill|meter|unit|count|consum|amount|stat|metric|input|output|cache|reason/i.test(k));
      // one sample record shape (keys only, per record type if present)
      if (Array.isArray(j.records) && j.records[0]) {
        rec.recordTypes = [...new Set(j.records.map(r => r && (r.type || r.event || r.kind || 'unknown')))].slice(0, 20);
      }
    } else {
      rec.head = t.slice(0, 300);
    }
    out.tries.push(rec);
    if (j) break;
  } catch (e) { out.tries.push({ u, err: String(e) }); }
}
return out;
