(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const seen = [];
  const origFetch = window.fetch;
  window.fetch = async function (u, o) {
    const url = String((u && u.url) || u);
    if (url.indexOf('/api/') > -1 || url.indexOf('/nextjs-api/') > -1) seen.push(((o && o.method) || 'GET') + ' ' + url.slice(0, 120));
    return origFetch.apply(this, arguments);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    if (String(u).indexOf('/api/') > -1) seen.push(m + ' ' + String(u).slice(0, 120));
    return origOpen.apply(this, arguments);
  };
  await wait(9000);
  window.fetch = origFetch;
  XMLHttpRequest.prototype.open = origOpen;
  out.apiCalls = [...new Set(seen)].slice(0, 30);
  out.bodyLen = (document.body ? document.body.innerText : '').length;
  out.hasCostUI = /\$[0-9]+\.[0-9]{2}/.test(document.body ? document.body.innerText : '');
  const g = async (u) => { try { const r = await fetch(u, {credentials:'include'}); return {s: r.status, len: (await r.text()).length}; } catch (e) { return {err: 1}; } };
  out.mePulse = await g('/api/me/pulse');
  out.me = await g('/api/me');
  return out;
})()
