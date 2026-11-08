(async () => {
  const t0 = Date.now();
  while (((document.body && document.body.innerText) || '').length < 200 && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 500));
  const txt = ((document.body && document.body.innerText) || '').replace(/\n{3,}/g, '\n\n');
  const links = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => /setting|billing|credit|account|portal|upgrade|plan|subscri/i.test(h || ''));
  return {url: location.href, len: txt.length, head: txt.slice(0, 3000), links: [...new Set(links)].slice(0, 30)};
})()
