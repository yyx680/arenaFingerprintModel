// Find a valid transcript cursor: check session payload pagination + page embedded data.
const sid = location.pathname.split('/').pop();
const out = { session: {}, cursorGuesses: [] };
const sess = await fetch('/api/chat/' + sid, { credentials: 'include' }).then(r => r.json()).catch(() => null);
if (sess) {
  out.session.pagination = sess.pagination ?? null;
  out.session.lastEventId = sess.lastEventId ?? null;
  out.session.topKeys = Object.keys(sess);
}
// search embedded page data for cursor-looking strings
const collect = (obj, path, depth) => {
  if (depth > 6 || !obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (/cursor/i.test(k) && typeof v === 'string' && v.length > 0) out.cursorGuesses.push((path ? path + '.' : '') + k + ' => ' + v.slice(0, 120));
    if (v && typeof v === 'object') collect(v, (path ? path + '.' : '') + k, depth + 1);
  }
};
if (window.__NEXT_DATA__) collect(window.__NEXT_DATA__, 'NEXT_DATA', 0);
// RSC flight payload embedded in self.__next_f?
if (Array.isArray(window.__next_f)) {
  for (const [, chunk] of window.__next_f) {
    if (typeof chunk !== 'string') continue;
    const re = /[Cc]ursor"?\s*[:=]\s*"([^"]{1,160})"/g;
    let m;
    while ((m = re.exec(chunk)) !== null && out.cursorGuesses.length < 20) {
      out.cursorGuesses.push('flight => ' + m[1].slice(0, 120));
    }
  }
}
// try any found cursors against the messages route
const tried = new Set();
for (const g of out.cursorGuesses) {
  const val = g.split(' => ')[1];
  if (!val || tried.has(val)) continue;
  tried.add(val);
  if (tried.size > 4) break;
  try {
    const resp = await fetch('/api/chat/' + sid + '/messages?cursor=' + encodeURIComponent(val), { credentials: 'include' });
    const t = await resp.text();
    out['try_' + val.slice(0, 30)] = { status: resp.status, body: t.slice(0, 260) };
  } catch (e) { out['try_err'] = String(e); }
}
return out;
