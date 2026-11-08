// 精读 trigger.dev realtime 客户端的 URL 构造与鉴权方式
const scripts = [...document.querySelectorAll('script[src]')].map((s) => s.src).filter((u) => /_next\//.test(u));
const wantFiles = ['0p4wzpl8hg5u3', '3m3q7j2kiyrmi', '0m2g_lwnwpece'];
const kw = ['realtime/v1', 'createSubscription', 'api.trigger.dev', 'Authorization', 'streams/', 'runs/', 'publicAccessToken', 'queryParams'];
const out = {};
for (const url of scripts) {
  const f = url.split('/').pop();
  if (!wantFiles.some((w) => f.includes(w))) continue;
  let t = '';
  try { t = await fetch(url).then((r) => r.text()); } catch { continue; }
  for (const w of kw) {
    let i = -1; let n = 0;
    while (n < 6) {
      i = t.indexOf(w, i + 1);
      if (i === -1) break;
      (out[w] = out[w] || []).push(f.slice(0, 22) + ' :: ' + t.slice(Math.max(0, i - 260), i + 300).replace(/\s+/g, ' '));
      n++;
    }
  }
}
return out;
