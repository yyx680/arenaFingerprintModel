(async () => {
  const h = await (await fetch('/api/history/unified?limit=4&includeArchived=false', {credentials:'include'})).json();
  const sid = (h.entries || [])[0].id;
  const r = await fetch('/api/evaluation/' + sid, {credentials:'include'});
  const j = await r.json();
  const msgs = j.messages || [];
  const a = msgs.find((m) => m.role === 'assistant');
  return {
    keys: Object.keys(a),
    meta: a.metadata,
    contentType: typeof a.content,
    contentLen: String(a.content || '').length,
    contentHead: String(a.content || '').slice(0, 200),
    hasParts: 'parts' in a,
    status: a.status,
    activeWorkflowRunId: a.activeWorkflowRunId ? String(a.activeWorkflowRunId).slice(0, 20) : null,
  };
})()
