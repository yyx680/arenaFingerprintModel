/* 403 攻坚 · 第七步：精确定位客户端对 /api/chat/:id/messages 的调用，读出 cursor 怎么造的。

   同时把 history 的 entries 按 type/productMode 分类，挑出真正的 agent chat id。 */
const out = {route_calls: [], cursor_snips: [], history: {}};

// ---------- history 分类 ----------
try {
  const r = await fetch('/api/history/unified?limit=30&includeArchived=false', {credentials: 'include'});
  const j = await r.json();
  const es = j.entries || [];
  out.history.count = es.length;
  out.history.keys = es[0] ? Object.keys(es[0]) : null;
  out.history.by_type = {};
  for (const e of es) {
    const k = `${e.type}|${e.productMode || '-'}`;
    out.history.by_type[k] = (out.history.by_type[k] || 0) + 1;
  }
  out.history.samples = es.slice(0, 6).map((e) => ({type: e.type, productMode: e.productMode, id: e.id, title: String(e.title || '').slice(0, 26), coding: e.codingSessionStatus}));
  // agent chat 候选：productMode 为 agent/chat 的
  out.history.agent_ids = es.filter((e) => /agent|chat/i.test(String(e.productMode || e.type || ''))).map((e) => e.id).slice(0, 10);
  out.history.all_ids = es.map((e) => e.id).slice(0, 10);
} catch (e) { out.history.error = String(e); }

// ---------- 扫 chunk 找 messages 路由调用 ----------
const urls = [...new Set(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js(\?|$)/.test(n)))];
const PATS = [
  ['messages.$get', /messages\.\$get/g],
  ['messages.$post', /messages\.\$post/g],
  ['query:{cursor', /query\s*:\s*\{[^}]{0,40}cursor/g],
  ['cursor:', /cursor\s*:/g],
];
for (const u of urls) {
  let text;
  try { text = await (await fetch(u)).text(); } catch { continue; }
  const name = u.split('/').pop().split('?')[0].slice(0, 34);
  for (const [label, re] of PATS) {
    re.lastIndex = 0;
    let m, n = 0;
    while ((m = re.exec(text)) !== null && n < 4) {
      n++;
      const snip = text.slice(Math.max(0, m.index - 320), m.index + 380).replace(/\s+/g, ' ');
      if (label === 'messages.$get' || label === 'messages.$post' || label === 'query:{cursor') {
        out.route_calls.push({label, chunk: name, snip});
      } else if (/transcript|cursor/i.test(snip) && out.cursor_snips.length < 30) {
        out.cursor_snips.push({chunk: name, snip: snip.slice(0, 500)});
      }
    }
  }
  if (out.route_calls.length > 8 && out.cursor_snips.length > 20) break;
}

// ---------- 直接找 "transcript cursor" 的错误串出处 / 编解码函数 ----------
out.cursor_codec = [];
for (const u of urls) {
  let text;
  try { text = await (await fetch(u)).text(); } catch { continue; }
  const name = u.split('/').pop().split('?')[0].slice(0, 34);
  for (const re of [/encodeCursor|decodeCursor|parseCursor|serializeCursor|makeCursor|toCursor/gi]) {
    re.lastIndex = 0;
    let m, n = 0;
    while ((m = re.exec(text)) !== null && n < 3) {
      n++;
      out.cursor_codec.push({chunk: name, fn: m[0], snip: text.slice(Math.max(0, m.index - 240), m.index + 300).replace(/\s+/g, ' ').slice(0, 460)});
    }
  }
}

return out;
