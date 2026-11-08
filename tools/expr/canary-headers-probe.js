// 响应头令牌 + 本地存储扫描
const sid = location.pathname.split('/').pop();
const out = {};
const r = await fetch('/api/chat/' + sid, {credentials: 'include'});
out.headers = [...r.headers.entries()].map(([k, v]) => k + ' = ' + (v.length > 120 ? v.slice(0, 120) + '…' : v));
out.localKeys = [];
for (let i = 0; i < localStorage.length; i++) {
  const k = localStorage.key(i);
  const v = localStorage.getItem(k) || '';
  out.localKeys.push(k + ' (' + v.length + ')' + (/usag|token|cost/i.test(v) ? ' [HIT:' + v.slice(0, 200) + ']' : ''));
}
try { out.idb = (await indexedDB.databases()).map((d) => d.name); } catch { out.idb = 'err'; }
// 会话状态里通常存 {publicAccessToken, lastEventId, ...}
for (const k of Object.keys(localStorage)) { /* noop */ }
out.sessionStorageKeys = [];
for (let i = 0; i < sessionStorage.length; i++) out.sessionStorageKeys.push(sessionStorage.key(i));
return out;
