/* 403 攻坚 · 第八步：
   A) 首屏 cursor 从哪来（找 F({sessionId,cursor}) 的调用方 / bootstrap 端点）
   B) bundle 里 credit-system / cost 门的判定条件是什么 */
const out = {A: [], B: [], C: []};
const urls = [...new Set(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js(\?|$)/.test(n)))];

const push = (arr, o) => { if (arr.length < 12) arr.push(o); };

for (const u of urls) {
  let text;
  try { text = await (await fetch(u)).text(); } catch { continue; }
  const name = u.split('/').pop().split('?')[0].slice(0, 34);

  // A) 首屏 cursor 来源
  for (const [label, re] of [
    ['TRANSCRIPT_PAGE_LIMIT', /TRANSCRIPT_PAGE_LIMIT/g],
    ['COMPLETE_TRANSCRIPT_PAGINATION', /COMPLETE_TRANSCRIPT_PAGINATION/g],
    ['bootstrap', /bootstrap/gi],
    ['transcriptCursor', /transcriptCursor/gi],
  ]) {
    re.lastIndex = 0;
    let m, n = 0;
    while ((m = re.exec(text)) !== null && n < 3) {
      n++;
      push(out.A, {label, chunk: name, snip: text.slice(Math.max(0, m.index - 300), m.index + 340).replace(/\s+/g, ' ').slice(0, 520)});
    }
  }

  // B) 计费门判定
  for (const [label, re] of [
    ['credit-system', /credit-system/gi],
    ['creditSystem', /creditSystem/gi],
    ['pricingStrategy', /pricingStrategy/gi],
    ['marginMultiplier', /marginMultiplier/gi],
    ['isFallback', /isFallback/gi],
  ]) {
    re.lastIndex = 0;
    let m, n = 0;
    while ((m = re.exec(text)) !== null && n < 3) {
      n++;
      push(out.B, {label, chunk: name, snip: text.slice(Math.max(0, m.index - 260), m.index + 300).replace(/\s+/g, ' ').slice(0, 480)});
    }
  }

  // C) 客户端是否自带费率表（能自己算价就不需要 /cost 接口）
  for (const [label, re] of [
    ['perMillion', /perMillion|PER_MILLION/gi],
    ['inputPrice', /inputPrice/gi],
    ['rateCard', /rateCard|rate_card/gi],
    ['CREDITS_PER_USD', /CREDITS_PER_USD/gi],
  ]) {
    re.lastIndex = 0;
    let m, n = 0;
    while ((m = re.exec(text)) !== null && n < 2) {
      n++;
      push(out.C, {label, chunk: name, snip: text.slice(Math.max(0, m.index - 240), m.index + 280).replace(/\s+/g, ' ').slice(0, 440)});
    }
  }
}
return out;
