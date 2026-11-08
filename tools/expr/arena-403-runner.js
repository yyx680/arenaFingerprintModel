/* 403 攻坚 · 第九步：找出 getRunnerActivity 的真实 URL 与 transcript cursor 的产生点。
   目标：拿到一个合法 cursor，打通**未设门**的 /api/chat/:id/messages。 */
const out = {urls: [], cursor_origin: [], api_like: []};
const urls = [...new Set(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js(\?|$)/.test(n)))];

for (const u of urls) {
  let text;
  try { text = await (await fetch(u)).text(); } catch { continue; }
  const name = u.split('/').pop().split('?')[0].slice(0, 34);

  // 1) getRunnerActivity 定义处 + 它调的 URL
  let i = text.indexOf('getRunnerActivity');
  if (i > -1) {
    for (const off of [0, 1]) {
      const j = text.indexOf('getRunnerActivity', i + 1 + off * 0);
      if (j < 0) break;
      out.urls.push({chunk: name, snip: text.slice(Math.max(0, j - 900), j + 200).replace(/\s+/g, ' ').slice(-1000)});
      i = j;
      if (out.urls.length > 6) break;
    }
  }

  // 2) 所有 api.xxx 的 Hono RPC 调用（route map）
  const RE = /api\.[A-Za-z0-9_]+(?:\[":id"\]|\[[^\]]{0,24}\])?(?:\.[A-Za-z0-9_]+)*(?:\[[^\]]{0,24}\])?(?:\.[A-Za-z0-9_]+)*\.\$(?:get|post|put|patch|delete)/g;
  let m, n = 0;
  while ((m = RE.exec(text)) !== null && n < 12) {
    n++;
    out.api_like.push({chunk: name, call: m[0]});
  }

  // 3) transcript cursor 的产生：找 cursor 与 pagination 一起出现的地方
  const RE2 = /(?:initialPagination|pagination)\s*[:=]\s*[A-Za-z0-9_.$()]{0,60}/g;
  let m2, n2 = 0;
  while ((m2 = RE2.exec(text)) !== null && n2 < 6) {
    n2++;
    out.cursor_origin.push({chunk: name, snip: text.slice(Math.max(0, m2.index - 260), m2.index + 300).replace(/\s+/g, ' ').slice(0, 480)});
  }
}
out.api_like = [...new Set(out.api_like.map((x) => x.chunk + ' :: ' + x.call))].slice(0, 60).map((s) => {
  const [chunk, call] = s.split(' :: ');
  return {chunk, call};
});
return out;
