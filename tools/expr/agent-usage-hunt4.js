/* Agent 用量猎取·第四步：挂 fetch 钩子，等用户在本窗口真实发一条消息，
   只记录响应里 usage/cost/tokens 类**字段名与数字**（绝不记录正文）。 */
const INTEREST = /usage|tokens?|cost|usd|credit|price|spend|billing/i;
const findings = [];
const urlsSeen = [];
const nativeFetch = window.fetch;
function record(text, url, via) {
  if (!text || text.length > 2000000) return;
  const short = url.replace('https://arena.ai', '').slice(0, 130);
  if (!urlsSeen.includes(short)) urlsSeen.push(short);
  const re = /\\?"([a-zA-Z_][a-zA-Z0-9_]*)\\?"\s*:\s*(\{|\[|\\?"|-?[0-9][0-9.eE+-]*)/g;
  let m; const keys = new Set();
  while ((m = re.exec(text))) {
    if (!INTEREST.test(m[1])) continue;
    const val = m[2] === '{' ? ':obj' : m[2] === '[' ? ':arr' : /^\\?"/.test(m[2]) ? ':str' : ':' + m[2].slice(0, 14);
    keys.add(m[1] + val);
    if (keys.size >= 40) break;
  }
  if (keys.size) findings.push({url: short, via, at: Date.now(), keys: [...keys]});
}
window.fetch = async function patchedFetch() {
  const url = String(typeof arguments[0] === 'string' ? arguments[0] : arguments[0]?.url || '');
  const resp = await nativeFetch.apply(this, arguments);
  try {
    if (/^\/|arena\.ai/.test(url)) {
      const type = String(resp.headers?.get?.('content-type') || '');
      if (/json|event-stream|text/.test(type) && typeof resp.clone === 'function') {
        const clone = resp.clone();
        if (/event-stream/.test(type) && clone.body && typeof clone.body.getReader === 'function') {
          const reader = clone.body.getReader();
          const dec = new TextDecoder();
          void (async () => {
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                record(dec.decode(chunk.value, {stream: true}), url, 'sse');
              }
            } catch { /* ignore */ }
          })();
        } else {
          void clone.text().then(text => record(text, url, 'body')).catch(() => {});
        }
      }
    }
  } catch { /* ignore */ }
  return resp;
};
const t0 = Date.now();
await new Promise(r => setTimeout(r, 105000));
try { window.fetch = nativeFetch; } catch { /* ignore */ }
return {window_ms: Date.now() - t0, urls_seen: urlsSeen.slice(0, 50), findings: findings.slice(0, 60)};
