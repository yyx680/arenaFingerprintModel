// 在 canary 的 Next.js bundle 里定位「流订阅」代码：streamToken / EventSource / usage 相关。
const scripts = [...document.querySelectorAll('script[src]')].map((s) => s.src).filter((u) => u.includes('/_next/'));
const want = ['includeStreamToken', 'streamToken', 'EventSource', 'publicAccessToken', 'trigger.dev', 'lastEventId', 'usage'];
const hits = {};
const cap = 5;
for (const url of scripts) {
  let t = '';
  try { t = await fetch(url).then((r) => r.text()); } catch { continue; }
  for (const w of want) {
    let i = -1; let n = 0;
    while (n < cap) {
      i = t.indexOf(w, i + 1);
      if (i === -1) break;
      (hits[w] = hits[w] || []).push(url.split('/').pop().slice(0, 30) + ' :: ' + t.slice(Math.max(0, i - 180), i + 260).replace(/\s+/g, ' '));
      n++;
    }
  }
  if (Object.keys(hits).length >= want.length && Object.values(hits).every((v) => v.length >= cap)) break;
}
return {chunksScanned: scripts.length, hits};
