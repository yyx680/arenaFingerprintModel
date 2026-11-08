// One bounded Arena Battle round in the existing dedicated Chrome CDP profile.
// Requires a caller-supplied NON-REPEATED prompt and answer; votes "both good"
// ONLY if both replies match the expected answer,
// and prints revealed model names plus provider usage. Never reads cookies or user chats.
import { setTimeout as delay } from 'node:timers/promises';
const expected = (process.argv[2] || '').trim();
const prompt = process.argv.slice(3).join(' ').trim();
if (!expected || expected.length > 40) throw new Error('Supply the expected short answer first');
if (prompt.length < 25 || prompt.length > 6500) {
  throw new Error('Supply one unique, non-sensitive prompt (25–6500 chars)');
}
const targets = await fetch('http://127.0.0.1:9333/json/list').then(r => r.json());
const page = targets.find(p => p.type === 'page' && p.url.startsWith('https://arena.ai/'));
if (!page) throw new Error('No Arena tab in dedicated Chrome');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener('message', e => {
  const msg = JSON.parse(e.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const p = pending.get(msg.id);
  pending.delete(msg.id);
  msg.error ? p.reject(msg.error) : p.resolve(msg.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};
try {
  await send('Page.bringToFront');
  // Use the app's own client-side New Chat navigation; a full reload can leave
  // an unfocused Chrome window stuck on an unresolved Next.js loading boundary.
  const route = await evaluate('location.pathname');
  if (route !== '/') {
    const newChat = await evaluate(`(${function () {
      const rootLinks = [...document.querySelectorAll('a[href="/"]')];
      const link = rootLinks.find(a =>
        /New Chat/i.test((a.textContent || '') + ' ' + (a.getAttribute('aria-label') || ''))) || rootLinks[0];
      if (!link) return false;
      link.click();
      return true;
    }})()`);
    if (!newChat) throw new Error('New Chat link not available; page left untouched');
  }
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await delay(750);
    ready = await evaluate("location.pathname === '/' && !!document.querySelector('textarea:not([aria-hidden])')?.getClientRects().length && document.body.innerText.includes('Battle')");
    if (ready) break;
  }
  if (!ready) throw new Error('Battle home did not become interactive');
  await delay(900); // let client-side navigation/hydration settle before touching the editor
  const sent = await evaluate(`(${async function (prompt) {
    const editor = [...document.querySelectorAll('textarea:not([aria-hidden])')].find(e => e.getClientRects().length);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, prompt);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    await new Promise(resolve => setTimeout(resolve, 300));
    if (editor.value !== prompt) return { sent: false, reason: 'editor-reset-during-navigation' };
    const button = document.querySelector('button[aria-label="Send message"]');
    if (!button || button.disabled) return { sent: false, reason: 'send-disabled' };
    button.click();
    return { sent: true, promptChars: prompt.length };
  }})(${JSON.stringify(prompt)})`);
  if (!sent?.sent) throw new Error(sent?.reason || 'Unable to send prompt');
  let status;
  for (let i = 0; i < 28; i++) {
    await delay(2100);
    status = await evaluate(`(${async function (expected) {
      const sid = location.pathname.match(/\/c\/([0-9a-f-]{30,40})/i)?.[1];
      if (document.body.innerText.includes('Security Verification')) return { status: 'verification-needed', sid: sid || null };
      if (!sid) return { status: 'waiting-for-session' };
      const response = await fetch('/api/evaluation/' + sid, { credentials: 'same-origin' });
      if (!response.ok) return { status: 'evaluation-' + response.status, sid };
      const j = await response.json();
      const answers = (j.messages || []).filter(m => m.role === 'assistant').slice(-2);
      if (answers.length !== 2 || answers.some(m => m.status !== 'success' || !m.metadata?.usage)) {
        return { status: 'generating', sid };
      }
      return { status: 'answered', sid,
        positions: answers.map(m => m.participantPosition),
        bothComplied: answers.every(m => typeof m.content === 'string'
          && m.content.trim().replace(/[.!。！]+$/, '').toLowerCase() === expected.toLowerCase()),
        lengths: answers.map(m => typeof m.content === 'string' ? m.content.length : null) };
    }})(${JSON.stringify(expected)})`);
    if (status?.status === 'answered' || status?.status === 'verification-needed') break;
  }
  if (status?.status === 'answered' && status.bothComplied) {
    const vote = await evaluate(`(${function () {
      const tie = [...document.querySelectorAll('button')].find(b => b.getClientRects().length && b.innerText?.trim() === '都好' && !b.disabled);
      if (!tie) return { voted: false, reason: 'no-visible-both-good-button' };
      tie.click();
      return { voted: true };
    }})()`);
    if (!vote?.voted) status = { ...status, status: 'manual-vote-needed', reason: vote?.reason };
    else {
      await delay(1800);
      const revealed = await evaluate(`(${async function () {
        const sid = location.pathname.split('/').at(-1);
        const j = await (await fetch('/api/evaluation/' + sid, { credentials: 'same-origin' })).json();
        const names = new Map((j.revealedModels || []).map(x => [x.id, x.displayName || x.publicName]));
        return { status: names.size ? 'revealed' : 'reveal-pending', sid,
          models: (j.messages || []).filter(m => m.role === 'assistant' && names.has(m.modelId)).slice(-2)
            .map(m => ({ model: names.get(m.modelId), position: m.participantPosition, usage: m.metadata?.usage || null })) };
      }})()`);
      status = revealed;
    }
  }
  console.log(JSON.stringify(status || { status: 'timed-out' }));
} finally { ws.close(); }
