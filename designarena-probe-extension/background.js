/* DesignArena 探针 v1.1 - MV3 Service Worker
 * 捕获即触发:抓到 Bearer / 会话 / public-access-token 后,后台自动反查身份并把结果落库,
 * popup 打开即看,无需任何手动步骤。 */
'use strict';

var STORE_KEYS = ['bearer', 'pubTokens', 'sessions', 'log', 'autoSessions', 'autoArena'];
var LOG_CAP = 300;
var PUB_CAP = 8;
var SESSION_CAP = 30;
var MODEL_HINT_RE = /"[a-zA-Z_.-]*(?:model|provider|engine)[a-zA-Z_.-]*"\s*:\s*"[^"]+"/gi;
var KNOWN_MODEL_RE = /\b(claude[- ][a-z0-9.-]*|gpt[- ][a-z0-9.-]*|gemini[- ][a-z0-9.-]*|llama[- ][a-z0-9.-]*|qwen[- ][a-z0-9.-]*|deepseek[- ][a-z0-9.-]*|mistral[- ][a-z0-9.-]*|grok[- ]?\w*|kimi[- ]?\w*|opus|sonnet|haiku|codex\b|o\d{1,2}\b)/gi;
var AGON = 'https://www.designarena.ai/api/agon';

var inflight = {}; /* 防并发重复探测 key -> true */

function nowIso() { return new Date().toISOString(); }

function decodeJwt(token) {
  try {
    var part = String(token).split('.')[1];
    if (!part) return null;
    var s = part.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return JSON.parse(decodeURIComponent(escape(atob(s))));
  } catch (e) { return null; }
}

function maskToken(t) {
  if (!t) return '';
  if (t.length <= 18) return t.slice(0, 6) + '…';
  return t.slice(0, 10) + '…' + t.slice(-6);
}

function getState() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(STORE_KEYS, function (s) {
      resolve({
        bearer: s.bearer || null,
        pubTokens: s.pubTokens || [],
        sessions: s.sessions || [],
        log: s.log || [],
        autoSessions: s.autoSessions || {},
        autoArena: s.autoArena || null
      });
    });
  });
}

function setPartial(obj) { return new Promise(function (r) { chrome.storage.local.set(obj, r); }); }

function pushLog(entry) {
  return getState().then(function (st) {
    var log = st.log.concat([entry]).slice(-LOG_CAP);
    return setPartial({ log: log });
  });
}

function refreshBadge() {
  return getState().then(function (st) {
    if (!chrome.action || !chrome.action.setBadgeText) return;
    var hits = 0;
    Object.keys(st.autoSessions).forEach(function (k) {
      var r = st.autoSessions[k];
      if (r && r.result && ((r.result.totalHints || 0) > 0)) hits++;
    });
    chrome.action.setBadgeText({ text: hits > 0 ? String(hits) : '' });
    chrome.action.setBadgeBackgroundColor({ color: hits > 0 ? '#1f9d62' : '#7c5cff' });
  });
}

/* ---------- 捕获器 ---------- */
function saveBearer(token, source) {
  var payload = decodeJwt(token) || {};
  var entry = { token: token, masked: maskToken(token), at: nowIso(), source: source, exp: payload.exp || 0, uid: payload.user_id || '', email: payload.email || '' };
  return getState().then(function (st) {
    if (st.bearer && st.bearer.token === token) return null;
    return setPartial({ bearer: entry })
      .then(function () { return pushLog({ at: nowIso(), type: 'bearer', text: '捕获登录 Bearer (' + (entry.email || entry.uid || '匿名') + ')', source: source }); })
      .then(function () { return entry; });
  }).then(function (newEntry) {
    if (!newEntry) return;
    /* 新 Bearer 到位:把所有“待凭据/过期凭据”会话统统扶正(auto 反查) */
    getState().then(function (st2) {
      st2.sessions.forEach(function (s) {
        autoProbeSession(s.id, false);
      });
    });
  });
}

function savePubToken(token, url) {
  var payload = decodeJwt(token) || {};
  var entry = { token: token, masked: maskToken(token), at: nowIso(), exp: payload.exp || 0, url: url || '' };
  return getState().then(function (st) {
    var list = st.pubTokens.filter(function (t) { return t.token !== token; });
    list.unshift(entry);
    list = list.slice(0, PUB_CAP);
    return setPartial({ pubTokens: list })
      .then(function () { return pushLog({ at: nowIso(), type: 'pubToken', text: '捕获 public-access-token', source: url }); })
      .then(function () { autoProbeArena(entry, false); });
  });
}

function upsertSession(sessionId, agents, url) {
  return getState().then(function (st) {
    var existed = st.sessions.some(function (s) { return s.id === sessionId; });
    var list = st.sessions.filter(function (s) { return s.id !== sessionId; });
    list.unshift({ id: sessionId, agents: agents || [], at: nowIso(), url: url || '' });
    list = list.slice(0, SESSION_CAP);
    return setPartial({ sessions: list })
      .then(function () {
        if (!existed) {
          return pushLog({ at: nowIso(), type: 'session', text: '发现会话 ' + sessionId + ' (' + (agents || []).length + ' 个 agent)', source: url });
        }
      })
      .then(function () { autoProbeSession(sessionId, false); })
      .then(refreshBadge);
  });
}

/* ---------- API 工具 ---------- */
function fetchJson(url, bearer, timeoutMs) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 30000);
  var headers = { 'Accept': 'application/json' };
  if (bearer) headers['Authorization'] = 'Bearer ' + bearer;
  return fetch(url, { headers: headers, credentials: 'omit', signal: ctrl.signal })
    .then(function (r) {
      clearTimeout(timer);
      return r.text().then(function (t) { return { status: r.status, ok: r.ok, text: t.slice(0, 30000) }; });
    })
    .catch(function (e) { clearTimeout(timer); return { status: 0, ok: false, text: String(e) }; });
}

function extractHints(text) {
  var out = {};
  var m;
  MODEL_HINT_RE.lastIndex = 0;
  while ((m = MODEL_HINT_RE.exec(text))) { out[m[0]] = 1; }
  return Object.keys(out).slice(0, 20);
}

function extractKnown(text) {
  var out = {};
  var m;
  KNOWN_MODEL_RE.lastIndex = 0;
  while ((m = KNOWN_MODEL_RE.exec(text))) { out[m[0].toLowerCase()] = 1; }
  return Object.keys(out).slice(0, 12);
}

/* ---------- 核心:反查一个会话 ---------- */
function runProbeSession(st, sessionId) {
  var bearer = st.bearer && st.bearer.token;
  var sess = st.sessions.filter(function (s) { return s.id === sessionId; })[0];
  var agents = (sess && sess.agents) || [];
  var results = { ok: true, sessionId: sessionId, at: nowIso(), bearerExp: st.bearer ? st.bearer.exp : 0, agents: [], eventHints: [], eventKnown: [], eventsPreview: '', totalHints: 0 };
  var chain = Promise.resolve();
  agents.forEach(function (mid) {
    chain = chain.then(function () {
      var rec = { id: mid };
      return fetchJson(AGON + '/api/sessions/' + encodeURIComponent(sessionId) + '/agents/' + encodeURIComponent(mid) + '/status', bearer)
        .then(function (r) { rec.statusHttp = r.status; if (r.ok) rec.statusText = r.text.slice(0, 300); })
        .then(function () { return fetchJson(AGON + '/api/sessions/' + encodeURIComponent(sessionId) + '/agents/' + encodeURIComponent(mid) + '/system-prompt', bearer); })
        .then(function (r) {
          rec.spHttp = r.status;
          if (r.ok) {
            rec.spHead = r.text.slice(0, 360);
            rec.spHints = extractHints(r.text).concat(extractKnown(r.text));
            results.totalHints += rec.spHints.length;
          }
        })
        .then(function () { return fetchJson(AGON + '/api/sessions/' + encodeURIComponent(sessionId) + '/agents/' + encodeURIComponent(mid) + '/tools', bearer); })
        .then(function (r) {
          rec.toolsHttp = r.status;
          if (r.ok) { try { rec.toolCount = JSON.parse(r.text).length; } catch (e) {} }
        })
        .then(function () { results.agents.push(rec); });
    });
  });
  return chain.then(function () {
    return fetchJson(AGON + '/api/sessions/' + encodeURIComponent(sessionId) + '/events?limit=100', bearer);
  }).then(function (r) {
    results.eventsHttp = r.status;
    if (r.ok) {
      results.eventHints = extractHints(r.text);
      results.eventKnown = extractKnown(r.text);
      results.eventsPreview = r.text.slice(0, 1200);
      results.totalHints += results.eventHints.length + results.eventKnown.length;
    }
    return results;
  });
}

/* ---------- 自动调度(采集即触发,防重复) ---------- */
function autoProbeSession(sessionId, force) {
  return getState().then(function (st) {
    var bearer = st.bearer;
    var key = sessionId + '@' + (bearer ? (bearer.exp || bearer.masked) : 'none');
    var cur = st.autoSessions[sessionId];
    if (!bearer) {
      if (!cur || !cur.pending) {
        var pendingMap = {};
        pendingMap[sessionId] = { pending: true, at: nowIso(), key: 'none' };
        return setPartial({ autoSessions: Object.assign({}, st.autoSessions, pendingMap) })
          .then(function () { return pushLog({ at: nowIso(), type: 'pending', text: '会话 ' + sessionId + ' 待反查:等待登录 Bearer', source: 'auto' }); });
      }
      return;
    }
    if (cur && cur.key === key && cur.result && !force) return;
    if (inflight[key]) return;
    inflight[key] = true;
    return pushLog({ at: nowIso(), type: 'auto', text: '自动反查会话 ' + sessionId + ' 中…', source: 'auto' })
      .then(function () { return runProbeSession(st, sessionId); })
      .then(function (res) {
        delete inflight[key];
        var map = {};
        map[sessionId] = { key: key, at: nowIso(), result: res };
        return getState().then(function (st2) {
          return setPartial({ autoSessions: Object.assign({}, st2.autoSessions, map) })
            .then(function () {
              return pushLog({ at: nowIso(), type: 'auto', text: '反查完成 ' + sessionId + ',线索 ' + res.totalHints + ' 条', source: 'auto' });
            })
            .then(refreshBadge);
        });
      })
      .catch(function (e) {
        delete inflight[key];
        return pushLog({ at: nowIso(), type: 'error', text: '自动反查 ' + sessionId + ' 失败: ' + String(e).slice(0, 120), source: 'auto' });
      });
  });
}

function autoProbeArena(tokEntry, force) {
  return getState().then(function (st) {
    if (st.autoArena && st.autoArena.token === tokEntry.token && st.autoArena.result && !force) return;
    var ikey = 'arena@' + tokEntry.masked;
    if (inflight[ikey]) return;
    inflight[ikey] = true;
    var payload = decodeJwt(tokEntry.token) || {};
    var runId = payload.run_id || payload.runId || payload.sub || payload.jti || '';
    var finish = function (result) {
      delete inflight[ikey];
      return setPartial({ autoArena: { token: tokEntry.token, tokenMasked: tokEntry.masked, at: nowIso(), result: result } })
        .then(function () { return pushLog({ at: nowIso(), type: 'auto', text: 'Trigger.dev 自动探测完成', source: 'auto' }); });
    };
    if (!runId) {
      return finish({ ok: false, error: 'token claims 无 runId', claims: payload });
    }
    var base = 'https://api.trigger.dev';
    var paths = ['/api/v3/runs/' + runId, '/api/v3/runs/' + runId + '/trace', '/api/v3/runs/' + runId + '/events'];
    var out = { ok: true, runId: runId, exp: payload.exp || 0, attempts: [] };
    var chain = Promise.resolve();
    paths.forEach(function (p) {
      chain = chain.then(function () {
        return fetchJson(base + p, tokEntry.token).then(function (r) {
          var item = { path: p, status: r.status };
          if (r.ok) { item.hints = extractHints(r.text); item.known = extractKnown(r.text); item.preview = r.text.slice(0, 600); }
          out.attempts.push(item);
        });
      });
    });
    return chain.then(function () { return finish(out); });
  });
}

/* ---------- webRequest 兜底捕获 ---------- */
var DaApiFilter = { urls: ['https://www.designarena.ai/api/*', 'https://designarena.ai/api/*'] };

try {
  chrome.webRequest.onSendHeaders.addListener(function (d) {
    var hs = d.requestHeaders || [];
    for (var i = 0; i < hs.length; i++) {
      if (/^authorization$/i.test(hs[i].name) && /^Bearer /i.test(hs[i].value || '')) {
        saveBearer(hs[i].value.replace(/^Bearer /i, ''), 'webRequest:' + d.url);
        break;
      }
    }
  }, DaApiFilter, ['requestHeaders', 'extraHeaders']);

  chrome.webRequest.onHeadersReceived.addListener(function (d) {
    var hs = d.responseHeaders || [];
    for (var i = 0; i < hs.length; i++) {
      if (/^public-access-token$/i.test(hs[i].name) && hs[i].value) {
        savePubToken(hs[i].value, d.url);
        break;
      }
    }
  }, DaApiFilter, ['responseHeaders', 'extraHeaders']);
} catch (e) {}

/* ---------- 消息路由 ---------- */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'daprobe:hook') {
    var p = msg.payload || {};
    var jobs = [];
    if (p.auth && /^Bearer /i.test(p.auth)) jobs.push(saveBearer(p.auth.replace(/^Bearer /i, ''), 'pageHook:' + p.url));
    if (p.pubToken) jobs.push(savePubToken(p.pubToken, p.url));
    if (p.method === 'POST' && /\/api\/agon\/api\/sessions$/.test(p.url) && p.bodyInfo && p.bodyInfo.sessionId) {
      jobs.push(upsertSession(p.bodyInfo.sessionId, p.bodyInfo.agents || [], p.url));
    }
    if (jobs.length === 0 && p.status >= 400) {
      jobs.push(pushLog({ at: nowIso(), type: 'http' + p.status, text: p.method + ' ' + p.url + ' -> ' + p.status, source: 'pageHook' }));
    }
    Promise.all(jobs).then(function () { sendResponse({ ok: true }); });
    return true;
  }

  if (msg.type === 'popup:get-state') {
    getState().then(function (st) {
      sendResponse({
        ok: true,
        bearer: st.bearer ? { masked: st.bearer.masked, at: st.bearer.at, exp: st.bearer.exp, email: st.bearer.email, uid: st.bearer.uid, token: st.bearer.token } : null,
        pubTokens: st.pubTokens.map(function (t) { return { masked: t.masked, at: t.at, exp: t.exp, url: t.url, token: t.token }; }),
        sessions: st.sessions,
        log: st.log.slice(-80),
        autoSessions: st.autoSessions,
        autoArena: st.autoArena ? { tokenMasked: st.autoArena.tokenMasked, at: st.autoArena.at, result: st.autoArena.result } : null
      });
    });
    return true;
  }

  if (msg.type === 'popup:probe-session' && msg.sessionId) {
    /* 手动按钮 = 强制重探 */
    autoProbeSession(msg.sessionId, true).then(function () {
      return getState();
    }).then(function (st) {
      var cur = st.autoSessions[msg.sessionId];
      if (cur && cur.result) { sendResponse(cur.result); return; }
      if (!st.bearer) { sendResponse({ ok: false, error: '尚未捕获到登录 Bearer。请先打开 designarena.ai 并登录/刷新页面。' }); return; }
      sendResponse({ ok: false, error: '探测未产出结果,详见日志。' });
    });
    return true;
  }

  if (msg.type === 'popup:probe-arena-token') {
    getState().then(function (st) {
      var tok = st.pubTokens[0];
      if (!tok) { sendResponse({ ok: false, error: '尚未捕获到 public-access-token。' }); return; }
      autoProbeArena(tok, true).then(function () { return getState(); }).then(function (st2) {
        sendResponse(st2.autoArena && st2.autoArena.result ? st2.autoArena.result : { ok: false, error: '探测未产出结果。' });
      });
    });
    return true;
  }

  if (msg.type === 'popup:clear') {
    chrome.storage.local.clear(function () { sendResponse({ ok: true }); });
    return true;
  }
});
