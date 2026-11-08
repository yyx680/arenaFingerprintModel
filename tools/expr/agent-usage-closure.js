(async () => {
  const sid = location.pathname.split('/').filter(Boolean).pop();
  const out = {sid, steps: [], cands: []};
  const chat = await fetch('/api/chat/' + sid, {credentials: 'include'}).then((r) => r.json()).catch((e) => ({err: String(e)}));
  const tok = chat.publicAccessToken || null;
  out.topKeys = Object.keys(chat);
  out.tokenLen = tok ? tok.length : 0;
  const tries = [
    location.origin + '/ai-proxy/realtime/v1/sessions/' + sid + '/out/records?io=out&afterEventId=0',
    'https://api.trigger.dev/realtime/v1/sessions/' + sid + '/out/records?io=out&afterEventId=0'
  ];
  for (const u of tries) {
    try {
      const r = await fetch(u, {headers: {'Authorization': 'Bearer ' + tok, 'x-trigger-source': 'sdk'}});
      const txt = await r.text();
      out.steps.push({u: u.slice(0, 90), status: r.status, len: txt.length});
      if (r.ok) {
        const j = JSON.parse(txt);
        const recs = j.records || [];
        out.recCount = recs.length;
        out.types = [];
        out.usageHits = [];
        for (const x of recs) {
          let b = x.data;
          if (typeof b === 'string') { try { b = JSON.parse(b); } catch {} }
          if (b && typeof b === 'object' && typeof b.body === 'string') { try { b.body = JSON.parse(b.body); } catch {} }
          const t = (b && (b.type || b.body && b.body.type)) || '?';
          out.types.push(t);
          const s = JSON.stringify(b);
          if (/usage|promptTokens|completionTokens|totalTokens|cacheReadTokens/i.test(s)) out.usageHits.push({seq: x.seqNum, hit: s.slice(0, 900)});
          if (x.seqNum >= 300 || /finish/.test(t)) out.steps.push({seq: x.seqNum, type: t, full: s.slice(0, 1500)});
        }
        break;
      }
    } catch (e) { out.steps.push({u: u.slice(0, 90), err: String(e)}); }
  }
  const cands = ['/api/chat/' + sid + '/usage', '/api/chat/' + sid + '/tokens', '/api/chat/' + sid + '/stats', '/api/chat/' + sid + '/eval', '/api/agent-logs/' + sid, '/api/coding-agent/sessions', '/api/me/usage'];
  for (const p of cands) {
    try { const r = await fetch(p, {credentials: 'include'}); const t = await r.text(); out.cands.push({p, s: r.status, len: t.length, head: t.slice(0, 220)}); } catch (e) { out.cands.push({p, err: String(e)}); }
  }
  return out;
})()
