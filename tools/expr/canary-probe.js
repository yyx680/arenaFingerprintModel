// Canary probe: auth state + gated routes + any usage surfaces.
const out = { href: location.href, title: document.title, routes: {} };
const probe = async (path, method = 'GET', body) => {
  try {
    const resp = await fetch(path, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body });
    const t = await resp.text();
    return { s: resp.status, b: t.slice(0, 300) };
  } catch (e) { return { err: String(e) }; }
};
out.routes.me = await probe('/api/me');
out.routes.pulse = await probe('/api/me/pulse');
out.routes.agentModels = await probe('/api/chat/agent-models');
out.routes.agentLogsUsage = await probe('/api/agent-logs/probe-test/usage', 'POST', '{}');
out.routes.agentLogsList = await probe('/api/agent-logs?limit=3');
out.routes.history = await probe('/api/history/unified?limit=3&includeArchived=false');
// body hints: logged-in chrome?
out.loginHint = !!document.querySelector('[href*="login"], [data-testid*="login"]');
out.userChip = (document.body.innerText || '').slice(0, 200);
return out;
