// canary：includeStreamToken=true 变体对照
const sid = location.pathname.split('/').pop();
const a = await fetch('/api/chat/' + sid + '?includeStreamToken=true', {credentials: 'include'}).then((r) => r.json()).catch(() => null);
const b = await fetch('/api/chat/' + sid + '?includeStreamToken=false', {credentials: 'include'}).then((r) => r.json()).catch(() => null);
const k = (x) => (x ? Object.keys(x) : null);
return {withToken: k(a), without: k(b), diffExtraKeys: a && b ? Object.keys(a).filter((x) => !(x in b)) : null};
