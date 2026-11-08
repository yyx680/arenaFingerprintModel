(async () => {
  const out = {};
  const h = await (await fetch('/api/history/unified?limit=30&includeArchived=false', {credentials:'include'})).json();
  const es = h.entries || [];
  out.count = es.length;
  const byType = {};
  for (const e of es) { byType[e.type] = (byType[e.type] || 0) + 1; }
  out.byType = byType;
  out.samples = es.slice(0, 12).map((e) => ({type: e.type, id: String(e.id).slice(0, 13), mode: e.mode, models: [e.modelAId, e.modelBId].filter(Boolean).map((m) => String(m).slice(0, 40))}));
  const eval1 = es.find((e) => e.type === 'evaluation');
  if (eval1) {
    const r = await fetch('/api/evaluation/' + eval1.id, {credentials:'include'});
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    out.eval = {status: r.status, len: t.length};
    if (j) {
      out.eval.topKeys = Object.keys(j);
      const msgs = j.messages || [];
      out.eval.msgCount = msgs.length;
      if (msgs[0]) out.eval.msg0keys = Object.keys(msgs[0]);
      if (msgs[0] && msgs[0].metadata) out.eval.meta0keys = Object.keys(msgs[0].metadata);
      const a = msgs.find((m) => m.role === 'assistant');
      if (a) { out.eval.asstKeys = Object.keys(a); out.eval.asstMetaKeys = a.metadata ? Object.keys(a.metadata) : null; }
      const s = JSON.stringify(j);
      const toks = [...new Set(s.match(/"[A-Za-z_]*(?:[Cc]ost|[Uu]sage|[Tt]okens|[Cc]redits|[Pp]rice|[Uu]sd|[Ss]pend)[A-Za-z_]*"\s*:/g) || [])];
      out.eval.costishKeys = toks.slice(0, 30);
      out.eval.hasRunId = /runId|run_id|trigger/i.test(s);
    }
  }
  return out;
})()
