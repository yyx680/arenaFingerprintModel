// Scan loaded JS chunks for references to agent-logs / usage routes.
const scripts = [...document.querySelectorAll('script[src]')].map(s => s.src).filter(u => u.includes('/_next/'));
const out = { total: scripts.length, hits: [] };
for (const url of scripts) {
  try {
    const t = await fetch(url).then(r => r.text());
    const re = /agent[-_]?log|\/usage|logUsage|usageFor|tokenUsage|agentLogId/gi;
    let m, seen = 0;
    while ((m = re.exec(t)) !== null && seen < 6) {
      seen++;
      out.hits.push({ url: url.split('/').pop(), ctx: t.slice(Math.max(0, m.index - 100), m.index + 160).replace(/\s+/g, ' ') });
    }
  } catch {}
}
return out;
