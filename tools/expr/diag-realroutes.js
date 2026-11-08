(async () => {
  const urls = [...new Set([...document.scripts].map((s) => s.src).filter((u) => u.indexOf('/_next/static/chunks/') > -1 && u.indexOf('.js') > -1))];
  const out = {chunks: urls.length, two: [], chatPost: [], storagePost: [], mePost: [], evalExtra: []};
  const PATS = [[/api\.chat\[[^\]]{1,30}\]\[[^\]]{1,30}\]\.\$post/g, 'two'], [/api\.chat\[[^\]]{1,30}\]\.\$post/g, 'chatPost'], [/api\.storage(\.[A-Za-z0-9_]+|\[[^\]]{1,30}\])+\.\$post/g, 'storagePost'], [/api\.me(\.[A-Za-z0-9_]+|\[[^\]]{1,30}\])+\.\$post/g, 'mePost'], [/api\.evaluation(\.[A-Za-z0-9_]+|\[[^\]]{1,30}\]){2,}\.\$get/g, 'evalExtra']];
  for (const u of urls) {
    let t = '';
    try { t = await (await fetch(u)).text(); } catch (e) { continue; }
    const short = u.split('/').pop().split('?')[0].slice(0, 24);
    for (const pair of PATS) { const re = pair[0]; const key = pair[1]; re.lastIndex = 0; let m; let c = 0; while ((m = re.exec(t)) !== null) { out[key].push(m[0].slice(0, 90) + '  [' + short + ']'); if (++c > 4) break; } }
  }
  for (const k of Object.keys(out)) { if (Array.isArray(out[k])) out[k] = [...new Set(out[k])].slice(0, 12); }
  return out;
})()
