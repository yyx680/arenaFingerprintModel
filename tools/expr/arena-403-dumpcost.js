/* 把成本计算 chunk 整份取回（同源，过 Cloudflare），供本地拆解。 */
const r = await fetch('/_next/static/chunks/0ao401ibhmepz.js');
if (!r.ok) return {error: 'HTTP ' + r.status};
const t = await r.text();
return {len: t.length, text: t};
