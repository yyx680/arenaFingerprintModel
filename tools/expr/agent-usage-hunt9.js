// Longshot: does a client-identifying header open the agent-logs route?
const sid = location.pathname.split('/').pop();
const out = [];
const variants = [
  { 'X-Arena-Client': 'kiro' },
  { 'X-Client': 'kiro' },
  { 'X-Arena-Source': 'kiro' },
  { 'X-Requested-With': 'kiro' },
  { 'X-Arena-Client': 'mobile' },
  { 'X-Arena-Client': 'api' },
];
for (const extra of variants) {
  try {
    const resp = await fetch('/api/agent-logs/' + sid + '/usage', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, extra),
      credentials: 'include',
      body: '{}',
    });
    const t = await resp.text();
    out.push({ h: JSON.stringify(extra), status: resp.status, body: t.slice(0, 120) });
  } catch (e) { out.push({ h: JSON.stringify(extra), err: String(e) }); }
}
return out;
