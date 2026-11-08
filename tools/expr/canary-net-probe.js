// 页面性能条目里的网络轨迹（含 SSE/流式请求 URL，带 query）
const ents = performance.getEntriesByType('resource').map((e) => ({i: e.initiatorType, n: e.name, ms: Math.round(e.duration), sz: e.transferSize}));
const trig = ents.filter((e) => /trigger\.dev/.test(e.n));
const arena = ents.filter((e) => /arena\.ai/.test(e.n) && /api|nextjs|stream|event|chat/.test(e.n)).slice(-80);
const wsLike = ents.filter((e) => /wss?:|socket|stream|eventsource|sse/i.test(e.n));
return {total: ents.length, trigger: trig, wsLike, arena};
