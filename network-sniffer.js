/* v2.9.0 网络层只读嗅探（MAIN world，document_start）。
   目的：arena.ai 页面自己的请求/响应里就带着模型线索，不用发任何探测消息。
     · 请求体里的 modelAId / model / modelBId 等字段（页面发送时带）
     · 响应头 public-access-token（一次运行一个公开 JWT，可换 Trigger.dev 运行轨迹）
     · 流式响应的分片到达时间与字节数（节奏通道的原始信号，见 rhythm-channel.js）
   铁律：只读。绝不改写请求、响应、headers 或 body；hook 只是包一层再原样调用。
   采集到的东西通过 window.postMessage 交给隔离世界的 content.js，再转 background.js。
   隐私：public JWT 会经 window.postMessage 临时桥接（同页脚本也可能看到）；扩展不把 token 写磁盘；流内容不落地，只留模型字段/分片时间和字节。 */
(() => {
  if (globalThis.__ampSnifferInstalled) return;
  globalThis.__ampSnifferInstalled = true;

  const SOURCE = 'amp-network-sniffer';
  const MODEL_KEYS = /^(model|modelaid|modelbid|model_a|model_b|modelid|model_id|modelname|model_name|llm|llmmodel|providermodel)$/i;
  const TOKEN_HEADER = 'public-access-token';
  const MAX_TEXT = 240;
  const MAX_EVIDENCE = 400;
  const MAX_MODELS = 40;
  const FLUSH_MS = 1500;

  const evidence = [];
  const models = [];
  const modelSeen = new Set();
  const tokenSeen = new Set();
  let aliveReported = false;
  const scanStats = {req: 0, body: 0, chunks: 0, urls: []};
  function rememberUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ''), location.origin);
      const entry = `${parsed.host}${parsed.pathname.slice(0, 48)}`;
      if (scanStats.urls[0] !== entry) {
        scanStats.urls.unshift(entry);
        scanStats.urls = scanStats.urls.slice(0, 6);
      }
    } catch { /* ignore */ }
  }
  /* 心跳：只要拦到第一条页面请求就上报一次，让浮层能区分「嗅探器没注入」和「注入了但没扫到东西」。 */
  function reportAlive() {
    if (aliveReported) return;
    aliveReported = true;
    evidence.push({kind: 'alive', at: Date.now()});
    schedule();
  }
  /* 让浮层能看到扫描量：请求几条、正文几条、流片几片（只计数，不含内容）。 */
  function reportStats() {
    evidence.push({kind: 'stats', req: scanStats.req, body: scanStats.body, chunks: scanStats.chunks, urls: scanStats.urls.slice(0, 6), at: Date.now()});
    schedule();
  }
  let timer = null;

  const now = () => Math.round(performance.now());

  function post() {
    if (!evidence.length && !models.length) return;
    const payload = { source: SOURCE, evidence: evidence.splice(0, evidence.length), models: models.splice(0, models.length), at: Date.now() };
    try { window.postMessage(payload, '*'); } catch { /* 页面可能已销毁 */ }
  }

  function schedule() {
    if (timer === null) timer = setTimeout(() => { timer = null; post(); }, FLUSH_MS);
  }

  function pushModel(name, where, url) {
    const value = String(name || '').slice(0, 120);
    if (!value) return;
    const requestUrl = String(url || '').slice(0, 200);
    const key = value + '|' + where + '|' + requestUrl;
    if (modelSeen.has(key)) return;
    modelSeen.add(key);
    models.push({ name: value, where, url: requestUrl });
    schedule();
  }

  function pushToken(token, url, extra) {
    const value = String(token || '');
    if (value.length < 20) return;
    const key = value.slice(0, 40);
    if (tokenSeen.has(key)) return;
    tokenSeen.add(key);
    evidence.push({ kind: 'token', token: value, url: String(url || '').slice(0, 200), at: Date.now(), ...extra });
    schedule();
  }

  /* v2.9.3：Arena 可能把运行 token 从响应头挪进了响应体/SSE。扫 JWT 形状的串，
     且解码后的 payload 含 run/trace/trigger/public/otel 才收，避免把页面登录态误当运行 token。 */
  function looksLikePublicRunToken(token) {
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), character => character.charCodeAt(0))));
      return /run|trace|trigger|public|otel/i.test(JSON.stringify(payload));
    } catch { return false; }
  }

  /* 从文本里挖 "model*": "value" 形式的字段；只取短值，避免把正文当模型名。 */
  function scanText(text, where, url) {
    const source = String(text || '');
    if (!source) return;
    // 页面性能：正文里不含任何可能命中的线索（model 字段 / JWT 前缀 / run_ id）时直接返回，跳过大请求体上的三次正则扫描。
    if (source.indexOf('model') < 0 && source.indexOf('eyJ') < 0 && source.indexOf('run_') < 0) return;
    const jwt = source.match(/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/);
    if (jwt && looksLikePublicRunToken(jwt[0])) pushToken(jwt[0], url, {via: where + ':jwt-body'});
    const re = /"(model[A-Za-z_]{0,12})"\s*:\s*"([^"]{1,80})"/g;
    let match;
    let guard = 0;
    while ((match = re.exec(source)) && guard < 40) {
      guard += 1;
      if (MODEL_KEYS.test(match[1]) || /^model/i.test(match[1])) pushModel(match[2], where + ':' + match[1], url);
    }
    const runId = source.match(/\brun_[A-Za-z0-9]{6,60}\b/);
    if (runId) pushModel(runId[0], where + ':runId', url);
    if (url) {
      const inUrl = String(url).match(/\brun_[A-Za-z0-9]{6,60}\b/);
      if (inUrl) pushModel(inUrl[0], 'url:runId', url);
    }
  }

  function scanHeaders(headers, url) {
    const get = typeof headers?.get === 'function' ? (name) => headers.get(name) : (name) => headers?.[name] ?? headers?.[String(name).toLowerCase()];
    const token = get(TOKEN_HEADER) || get('x-public-access-token') || get('public_access_token');
    if (token) pushToken(token, url, { via: 'header' });
  }

  function streamStats(runId, url) {
    return { kind: 'stream', runId, url: String(url || '').slice(0, 200), t0: now(), chunks: 0, bytes: 0, gaps: [], last: 0 };
  }

  function recordChunk(stream, size) {
    const at = now();
    if (stream.last) {
      const gap = at - stream.last;
      if (stream.gaps.length < 4000) stream.gaps.push(gap);
    }
    stream.last = at;
    stream.chunks += 1;
    stream.bytes += Number(size) || 0;
  }

  function finishStream(stream) {
    if (!stream.chunks) return;
    evidence.push({
      kind: 'stream',
      runId: stream.runId,
      url: stream.url,
      chunks: stream.chunks,
      bytes: stream.bytes,
      duration_ms: now() - stream.t0,
      gaps: stream.gaps.slice(0, 2000),
      at: Date.now(),
    });
    if (evidence.length > MAX_EVIDENCE) evidence.splice(0, evidence.length - MAX_EVIDENCE);
    schedule();
  }

  const runIdOf = (url) => (String(url || '').match(/\brun_[A-Za-z0-9]{6,60}\b/) || [null])[0];

  /* ---------- fetch ---------- */
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function patchedFetch(input, init) {
      reportAlive();
      scanStats.req += 1;
      let url = '';
      let bodyText = '';
      let requestBody = null;
      try {
        url = typeof input === 'string' ? input : (input?.url || '');
        const raw = init?.body;
        if (typeof raw === 'string') bodyText = raw;
        else if (raw instanceof URLSearchParams) bodyText = raw.toString();
        else if (typeof FormData === 'function' && raw instanceof FormData) {
          try { requestBody = new Response(raw).text().catch(() => ''); } catch { /* ignore */ }
        }
        else if (raw == null && typeof Request === 'function' && input instanceof Request && input.body) {
          // clone() gives us a second reader without locking or changing the page's original Request.
          requestBody = input.clone().text().catch(() => '');
        }
      } catch { /* 读不到就算了 */ }
      rememberUrl(url);
      if (bodyText) { scanStats.body += 1; scanText(bodyText.slice(0, 200000), 'fetch.request', url); }
      else if (requestBody) void requestBody.then((text) => { if (text) { scanStats.body += 1; scanText(text.slice(0, 200000), 'fetch.request', url); } }).catch(() => {});
      reportStats();
      const result = nativeFetch.apply(this, arguments);
      if (!(result instanceof Promise)) return result;
      return result.then((response) => {
        try {
          scanHeaders(response.headers, url);
          const type = String(response.headers?.get?.('content-type') || '');
          if (/event-stream|json|text/i.test(type) && typeof response.clone === 'function') {
            const stream = streamStats(runIdOf(url), url);
            const clone = response.clone();
            if (clone?.body && typeof clone.body.getReader === 'function') {
              const reader = clone.body.getReader();
              const pump = () => reader.read().then((chunk) => {
                if (chunk?.value) {
                  recordChunk(stream, chunk.value.byteLength || chunk.value.length || 0);
                  scanStats.chunks += 1;
                  /* fetch 流的分片是 Uint8Array，必须先解码再扫 —— 旧代码只扫 string 分片，等于从没扫过流。 */
                  const text = typeof chunk.value === 'string'
                    ? chunk.value
                    : (() => { try { return new TextDecoder('utf-8').decode(chunk.value); } catch { return ''; } })();
                  if (text) scanText(text.slice(0, MAX_TEXT * 40), 'fetch.stream', url);
                  return pump();
                }
                finishStream(stream);
                return undefined;
              }).catch(() => finishStream(stream));
              void pump();
            } else {
              void clone.text().then((text) => {
                recordChunk(stream, text.length);
                scanText(text.slice(0, 200000), 'fetch.body', url);
                finishStream(stream);
              }).catch(() => {});
            }
          }
        } catch { /* 只读观测失败不影响页面 */ }
        return response;
      });
    };
  }

  /* ---------- XMLHttpRequest ---------- */
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    try { this.__ampUrl = String(url || ''); } catch { /* ignore */ }
    return nativeOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function patchedSend(body) {
    try {
      reportAlive();
      scanStats.req += 1;
      rememberUrl(this.__ampUrl);
      if (typeof body === 'string') { scanStats.body += 1; scanText(body.slice(0, 200000), 'xhr.request', this.__ampUrl); }
      reportStats();
      this.addEventListener('load', () => {
        try {
          const token = this.getResponseHeader?.(TOKEN_HEADER) || this.getResponseHeader?.('x-public-access-token');
          if (token) pushToken(token, this.__ampUrl, { via: 'xhr-header' });
          const type = String(this.getResponseHeader?.('content-type') || '');
          if (/json|text/i.test(type) && typeof this.responseText === 'string') scanText(this.responseText.slice(0, 200000), 'xhr.response', this.__ampUrl);
        } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
    return nativeSend.apply(this, arguments);
  };

  /* ---------- EventSource ---------- */
  const NativeEventSource = window.EventSource;
  if (typeof NativeEventSource === 'function') {
    const patchedEventSource = function PatchedEventSource(url, config) {
      const source = config === undefined ? new NativeEventSource(url) : new NativeEventSource(url, config);
      try {
        const stream = streamStats(runIdOf(url), url);
        rememberUrl(url);
        source.addEventListener('message', (event) => {
          recordChunk(stream, String(event?.data || '').length);
          scanStats.chunks += 1;
          scanText(String(event?.data || '').slice(0, MAX_TEXT * 40), 'eventsource', url);
        });
        source.addEventListener('error', () => finishStream(stream));
        window.addEventListener('pagehide', () => finishStream(stream), { once: true });
      } catch { /* ignore */ }
      return source;
    };
    patchedEventSource.prototype = NativeEventSource.prototype;
    try {
      Object.defineProperty(patchedEventSource, 'name', { value: 'EventSource', configurable: true });
      for (const key of Object.getOwnPropertyNames(NativeEventSource)) {
        if (!(key in patchedEventSource)) {
          try { patchedEventSource[key] = NativeEventSource[key]; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    window.EventSource = patchedEventSource;
  }

  /* ---------- Worker 搭车扫描 ---------- */
  /* v2.9.3：已确认 Arena 的聊天请求（/api/chat/*）从 Web Worker 发出，页面主线程钩子看不到。
     这里包一层 Worker/SharedWorker 构造器：额外挂一个只读 message 监听扫往返数据，
     outgoing postMessage 只扫不改 —— 不触碰页面自己的回调，不改变任何数据。 */
  /* v2.9.24：主线程降耗 —— 高频 Worker/WS 消息不再整包 JSON.stringify：字符串直扫；
     对象只收短字段（<=2KB 字符串、小嵌套对象、标量），大字符串与二进制直接跳过（顺带更贴合「流内容不落地」）。 */
  function scanableText(data) {
    if (typeof data === 'string') return data;
    if (!data || typeof data !== 'object') return '';
    if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer || (typeof Blob !== 'undefined' && data instanceof Blob)) return '';
    try {
      const parts = []; let size = 0;
      for (const key of Object.keys(data)) {
        const value = data[key];
        if (typeof value === 'string') { if (value.length <= 2048) { parts.push(value); size += value.length; } }
        else if (typeof value === 'number' || typeof value === 'boolean') { parts.push(String(value)); size += 4; }
        else if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !(typeof Blob !== 'undefined' && value instanceof Blob)) {
          try { const s = JSON.stringify(value); if (s && s.length <= 2048) { parts.push(s); size += s.length; } } catch { /* ignore */ }
        }
        if (size > 8192) break;
      }
      return parts.join(' ');
    } catch { return ''; }
  }
  function tapPort(port, label) {
    try {
      port.addEventListener('message', (event) => {
        scanStats.chunks += 1;
        const text = scanableText(event?.data);
        if (text) scanText(text.slice(0, MAX_TEXT * 40), label + ':in', '');
      });
    } catch { /* ignore */ }
  }
  const NativeWorker = window.Worker;
  if (typeof NativeWorker === 'function') {
    function PatchedWorker(url, options) {
      const worker = new NativeWorker(url, options);
      try {
        tapPort(worker, 'worker');
        const nativePost = worker.postMessage.bind(worker);
        worker.postMessage = function patchedWorkerPost() {
          try {
            scanStats.body += 1;
            const text = scanableText(arguments[0]);
            if (text) scanText(text.slice(0, 200000), 'worker:out', String(url || '').slice(0, 120));
          } catch { /* ignore */ }
          return nativePost.apply(null, arguments);
        };
      } catch { /* ignore */ }
      return worker;
    }
    PatchedWorker.prototype = NativeWorker.prototype;
    window.Worker = PatchedWorker;
  }
  const NativeSharedWorker = window.SharedWorker;
  if (typeof NativeSharedWorker === 'function') {
    function PatchedSharedWorker(url, options) {
      const shared = new NativeSharedWorker(url, options);
      try { tapPort(shared.port, 'shared-worker'); } catch { /* ignore */ }
      return shared;
    }
    PatchedSharedWorker.prototype = NativeSharedWorker.prototype;
    window.SharedWorker = PatchedSharedWorker;
  }

  /* ---------- WebSocket ---------- */
  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === 'function') {
    const patchedWebSocket = function PatchedWebSocket(url, protocols) {
      const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
      try {
        const stream = streamStats(runIdOf(url), url);
        socket.addEventListener('message', (event) => {
          const data = event?.data;
          const size = typeof data === 'string' ? data.length : (data?.byteLength || data?.size || 0);
          recordChunk(stream, size);
          if (typeof data === 'string') scanText(data.slice(0, MAX_TEXT * 40), 'websocket', url);
        });
        socket.addEventListener('close', () => finishStream(stream));
      } catch { /* ignore */ }
      return socket;
    };
    patchedWebSocket.prototype = NativeWebSocket.prototype;
    try {
      Object.defineProperty(patchedWebSocket, 'name', { value: 'WebSocket', configurable: true });
      for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) patchedWebSocket[key] = NativeWebSocket[key];
    } catch { /* ignore */ }
    window.WebSocket = patchedWebSocket;
  }

  window.addEventListener('pagehide', () => { if (timer !== null) { clearTimeout(timer); timer = null; } post(); });
})();
