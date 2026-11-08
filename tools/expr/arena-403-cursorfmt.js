/* 403 攻坚 · 第六步：找到 "transcript cursor" 的格式。

   /api/chat/<agentChatId>/messages 是**未设门**的（不是 403），只差一个合法 cursor。
   在已加载的 JS chunk 里搜 "transcript" / cursor 的构造代码。 */
const out = {chunks: 0, hits: []};

// 1) 正确解析 history（真正的键是 entries）
try {
  const r = await fetch('/api/history/unified?limit=30&includeArchived=false', {credentials: 'include'});
  const j = await r.json();
  const entries = j.entries || [];
  out.history_entries = entries.length;
  out.history_entry_keys = entries[0] ? Object.keys(entries[0]) : null;
  out.history_sample = entries.slice(0, 8).map((e) => ({id: e.id, type: e.type, mode: e.mode, kind: e.kind, title: String(e.title || '').slice(0, 28)}));
  const kinds = {};
  for (const e of entries) { const k = String(e.type || e.mode || e.kind || '?'); kinds[k] = (kinds[k] || 0) + 1; }
  out.history_kinds = kinds;
  out.chat_ids = entries.filter((e) => /chat|agent/i.test(String(e.type || e.mode || e.kind || ''))).map((e) => e.id).slice(0, 10);
  out.all_ids = entries.map((e) => e.id).slice(0, 10);
} catch (e) { out.history_error = String(e); }

// 2) 扫 chunk 找 transcript cursor
const urls = [...new Set(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js(\?|$)/.test(n)))];
out.chunks = urls.length;
const RE = /transcript/gi;
for (const u of urls) {
  let text;
  try { text = await (await fetch(u)).text(); } catch { continue; }
  if (!RE.test(text)) { RE.lastIndex = 0; continue; }
  RE.lastIndex = 0;
  // 抓 transcript 附近的片段
  let m;
  const seen = new Set();
  while ((m = RE.exec(text)) !== null) {
    const s = Math.max(0, m.index - 220);
    const snip = text.slice(s, m.index + 260).replace(/\s+/g, ' ');
    const key = snip.slice(60, 140);
    if (seen.has(key)) continue;
    seen.add(key);
    out.hits.push({chunk: u.split('/').pop().slice(0, 40), snip: snip.slice(0, 460)});
    if (out.hits.length >= 25) break;
  }
  if (out.hits.length >= 25) break;
}

// 3) 顺手找 messages 路由的调用与 cursor 参数名
out.route_calls = [];
for (const u of urls) {
  let text;
  try { text = await (await fetch(u)).text(); } catch { continue; }
  if (!/\.messages\.\$get|messages\?cursor|transcriptCursor/.test(text)) continue;
  const i = text.search(/\.messages\.\$get|messages\?cursor|transcriptCursor/);
  out.route_calls.push({chunk: u.split('/').pop().slice(0, 40), snip: text.slice(Math.max(0, i - 300), i + 320).replace(/\s+/g, ' ')});
  if (out.route_calls.length >= 6) break;
}

return out;
