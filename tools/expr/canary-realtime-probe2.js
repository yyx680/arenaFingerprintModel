// 找 realtime sessions 的调用点：stream 名、鉴权方式
const scripts = [...document.querySelectorAll('script[src]')].map((s) => s.src).filter((u) => /_next\//.test(u));
const kw = ['subscribeToSessionStream', 'readSessionStreamRecords', 'transcriptReadStrategy', 'triggerAddress', 'Bearer ', 'x-trigger-public', 'trigger-public-token', 'publicAccessToken='];
const out = {};
for (const url of scripts) {
  const f = url.split('/').pop().slice(0, 22);
  let t = '';
  try { t = await fetch(url).then((r) => r.text()); } catch { continue; }
  for (const w of kw) {
    let i = -1; let n = 0;
    while (n < 4) {
      i = t.indexOf(w, i + 1);
      if (i === -1) break;
      (out[w] = out[w] || []).push(f + ' :: ' + t.slice(Math.max(0, i - 230), i + 330).replace(/\s+/g, ' '));
      n++;
    }
  }
}
return out;
