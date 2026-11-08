// 真发一条消息：创建 evaluation → 读流 → 轮询会话 → 记录 usage / 额度变化
const out = { at: new Date().toISOString() };
const t0 = Date.now();

function uuidv7() {
  const ts = Date.now();
  const b = new Uint8Array(16);
  let n = ts;
  for (let i = 5; i >= 0; i--) { b[i] = n & 0xff; n = Math.floor(n / 256); }
  crypto.getRandomValues(b.subarray(6));
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
}

const pulse = async () => { try { const r = await fetch('/api/me/pulse', { credentials: 'include' }); return { status: r.status, body: await r.json() }; } catch (e) { return { err: e.message }; } };

out.pulseBefore = await pulse();
try { out.meBefore = JSON.stringify(await (await fetch('/api/me', { credentials: 'include' })).json()).slice(0, 900); } catch {}

const sid = uuidv7();
out.sid = sid;
const body = {
  id: sid,
  mode: 'battle',
  userMessageId: uuidv7(),
  modelAMessageId: uuidv7(),
  modelBMessageId: uuidv7(),
  userMessage: { content: '1+1=? 只输出数字', experimental_attachments: [], metadata: {} },
  modality: 'webdev',
  recaptchaV3Token: null,
};

const r = await fetch('/nextjs-api/stream/create-evaluation', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'text/plain' },
  credentials: 'include',
  body: JSON.stringify(body),
});
out.sendStatus = r.status;
out.rateHeaders = {
  limit: r.headers.get('ratelimit-limit'),
  policy: r.headers.get('ratelimit-policy'),
  remaining: r.headers.get('ratelimit-remaining'),
  retryAfter: r.headers.get('retry-after'),
};

// 有界读流（最多 25s，避免被 webdev 长构建阻塞）
let buf = '';
try {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  const tEnd = Date.now() + 25000;
  while (Date.now() < tEnd) {
    const race = await Promise.race([
      reader.read().then((v) => ({ v })),
      new Promise((res) => setTimeout(() => res({ to: true }), 4000)),
    ]);
    if (race.to) continue;
    const { value, done } = race.v;
    if (done) break;
    if (value) buf += dec.decode(value, { stream: true });
  }
  try { await reader.cancel(); } catch {}
} catch (e) { out.streamErr = e.message; }

out.streamLen = buf.length;
out.streamHead = buf.slice(0, 400);
const kw = buf.match(/"(usage|cost|totalCostUsd|totalChargedUsd|credits|inputTokens|outputTokens)"\s*:/g);
out.streamTokens = kw ? [...new Set(kw)] : [];
const ci = buf.search(/usage|cost|credits/i);
out.streamCtx = ci >= 0 ? buf.slice(Math.max(0, ci - 250), ci + 500) : null;

// 轮询会话直到 assistant 消息结算（最多 ~150s）
out.poll = [];
for (let k = 0; k < 15; k++) {
  await new Promise((res) => setTimeout(res, 10000));
  try {
    const rr = await fetch('/api/evaluation/' + sid, { headers: { accept: 'application/json' }, credentials: 'include' });
    if (rr.status !== 200) { out.poll.push({ k, status: rr.status }); continue; }
    const j = await rr.json();
    const msgs = (j.messages || []).filter((m) => m.role === 'assistant');
    const snap = msgs.map((m) => ({ pos: m.participantPosition, status: m.status, modelId: m.modelId, usage: m.metadata?.usage ?? null, cost: m.metadata?.cost ?? null }));
    out.poll.push({ k, n: msgs.length, snap });
    if (msgs.length && msgs.every((m) => m.status === 'success' && m.metadata?.usage)) { out.settledAt = k; break; }
  } catch (e) { out.poll.push({ k, err: e.message }); }
}

out.pulseAfter = await pulse();
try {
  const j = await (await fetch('/api/evaluation/' + sid, { headers: { accept: 'application/json' }, credentials: 'include' })).json();
  out.finalMsgs = (j.messages || []).map((m) => ({ role: m.role, pos: m.participantPosition, status: m.status, modelId: m.modelId, usage: m.metadata?.usage ?? null, cost: m.metadata?.cost ?? null, costish: Object.fromEntries(Object.entries(m.metadata || {}).filter(([k]) => /cost|credit|price|charge|spend/i.test(k))) }));
  out.revealedModels = (j.revealedModels || []).slice(0, 4);
} catch (e) { out.finalErr = e.message; }

// 试 /cost 路由（Bearer 与否）
let tok = null;
try { tok = decodeURIComponent((document.cookie.match(/arena-auth-prod-v1\.[01]=([^;]+)/) || [])[1] || ''); } catch {}
out.costRoute = [];
for (const [label, h] of [['cookie', { accept: 'application/json' }], ['bearer', tok ? { accept: 'application/json', authorization: 'Bearer ' + tok } : null]].filter((x) => x[1])) {
  try { const rr = await fetch('/api/evaluation/' + sid + '/cost', { headers: h, credentials: 'include' }); out.costRoute.push({ label, status: rr.status, body: (await rr.text()).slice(0, 400) }); } catch (e) { out.costRoute.push({ label, err: e.message }); }
}

out.elapsedMs = Date.now() - t0;
return out;
