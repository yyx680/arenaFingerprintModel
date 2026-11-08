(async () => {
  const h = await (await fetch('/api/history/unified?limit=8&includeArchived=false', {credentials: 'include'})).json();
  const out = {sessions: []};
  for (const e of (h.entries || []).slice(0, 3)) {
    const cj = await (await fetch(`/api/chat/${e.id}`, {credentials: 'include'})).json();
    const tok = cj.publicAccessToken || '';
    const parts = tok.split('.');
    const dec = (s) => { try { return JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return String(e); } };
    out.sessions.push({sid: e.id, triggerAddress: cj.triggerAddress, taskId: cj.taskId, header: dec(parts[0] || ''), payload: dec(parts[1] || ''), sigLen: (parts[2] || '').length});
  }
  return out;
})()
