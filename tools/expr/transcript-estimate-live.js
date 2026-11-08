(async () => {
  const CJK = (cp) => (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x20000 && cp <= 0x2ffff);
  const buckets = (text) => {
    const out = {chars: 0, cjk: 0, other: 0};
    for (const ch of String(text || '')) { if (CJK(ch.codePointAt(0))) out.cjk += 1; else out.other += 1; out.chars += 1; }
    return out;
  };
  const tokensOf = (b) => Math.round(b.cjk + b.other * 0.27);
  const h = await (await fetch('/api/history/unified?limit=6&includeArchived=false', {credentials: 'include'})).json();
  const sid = (h.entries || [])[0]?.id;
  const r = await fetch('/api/chat/' + sid, {credentials: 'include'});
  const j = await r.json();
  const out = {sid, status: r.status, pinnedModel: j.pinnedModel ?? null, message_count: (j.messages || []).length, messages: [], totals: {assistants: 0, output_tokens: 0, text_chars: 0, reasoning_chars: 0}};
  for (const m of (j.messages || [])) {
    const parts = Array.isArray(m.parts) ? m.parts : [];
    const text = {chars: 0, cjk: 0, other: 0};
    const reasoning = {chars: 0, cjk: 0, other: 0};
    for (const p of parts) {
      if (!p || typeof p.text !== 'string') continue;
      const bucket = p.type === 'reasoning' ? reasoning : (p.type === 'text' ? text : null);
      if (!bucket) continue;
      const b = buckets(p.text);
      bucket.chars += b.chars; bucket.cjk += b.cjk; bucket.other += b.other;
    }
    const row = {id: String(m.id || '').slice(0, 12), role: m.role, text, reasoning, est_output_tokens: tokensOf(text) + tokensOf(reasoning)};
    if (m.role === 'assistant') { out.totals.assistants += 1; out.totals.output_tokens += row.est_output_tokens; }
    out.totals.text_chars += text.chars;
    out.totals.reasoning_chars += reasoning.chars;
    out.messages.push(row);
  }
  return out;
})()
