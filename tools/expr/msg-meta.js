(async () => {
  const out = {};
  const h = await (await fetch('/api/history/unified?limit=6&includeArchived=false', {credentials: 'include'})).json();
  const sid = (h.entries || [])[0].id;
  out.sid = sid;
  const cj = await (await fetch(`/api/chat/${sid}`, {credentials: 'include'})).json();
  out.pagination = cj.pagination;
  out.msgKeys = (cj.messages || []).map((m) => Object.keys(m));
  out.msg0 = JSON.stringify((cj.messages || [])[0]).slice(0, 900);
  out.msg1 = JSON.stringify((cj.messages || [])[1]).slice(0, 900);
  const cur = cj.pagination && (cj.pagination.cursor || cj.pagination.nextCursor || cj.pagination.endCursor);
  out.cursorTried = cur || null;
  if (cur) { const r = await fetch(`/api/chat/${sid}/messages?cursor=${encodeURIComponent(cur)}`, {credentials: 'include'}); const t = await r.text(); out.msgsRoute = {s: r.status, len: t.length, hasUsage: /usage/i.test(t), hasCost: /cost/i.test(t), hasToken: /token/i.test(t), head: t.slice(0, 600)}; }
  // also try first message id as cursor
  const mid = (cj.messages || [])[0] && cj.messages[0].id;
  if (mid) { const r = await fetch(`/api/chat/${sid}/messages?cursor=${mid}`, {credentials: 'include'}); const t = await r.text(); out.midCursor = {s: r.status, len: t.length, hasUsage: /usage/i.test(t), hasCost: /cost/i.test(t), head: t.slice(0, 600)}; }
  return out;
})()
