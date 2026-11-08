/* DesignArena 探针 v1.1 - popup 逻辑(捕获即触发,打开即看结果) */
'use strict';

var state = null;
var $ = function (id) { return document.getElementById(id); };

function send(msg) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(msg, function (r) {
      void chrome.runtime.lastError;
      resolve(r || { ok: false, error: 'background 未响应' });
    });
  });
}

function fmtExp(exp) {
  if (!exp) return '';
  var ms = exp * 1000 - Date.now();
  var d = new Date(exp * 1000);
  var s = d.toLocaleString();
  if (ms <= 0) return s + '(已过期)';
  var m = Math.floor(ms / 60000);
  if (m > 120) return s + '(还有 ' + Math.floor(m / 60) + '小时)';
  return s + '(还有 ' + m + ' 分钟)';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function renderAutoArena() {
  var holder = $('pub-auto');
  var aa = state.autoArena;
  if (!aa || !aa.result) { holder.innerHTML = ''; return; }
  var r = aa.result;
  var html = '<div class="dim">自动探测 @ ' + esc(aa.at.slice(11, 19)) + '</div>';
  if (!r.ok) { html += '<div class="dim">' + esc(r.error || '失败') + '</div>'; }
  else {
    html += '<div class="dim">runId: ' + esc(r.runId) + '</div>';
    (r.attempts || []).forEach(function (a) {
      html += '<div class="dim">' + esc(a.path) + ' → HTTP ' + a.status + '</div>';
      var hits = (a.known || []).concat(a.hints || []);
      if (hits.length) html += '<div class="hit">' + esc(hits.slice(0, 12).join(' ｜ ')) + '</div>';
      if (a.preview) html += '<pre>' + esc(a.preview) + '</pre>';
    });
  }
  holder.innerHTML = html;
}

function renderSessionAuto(sid) {
  var cur = state.autoSessions && state.autoSessions[sid];
  if (!cur) return '<div class="dim">等待自动反查…</div>';
  if (cur.pending) return '<div class="dim">已填会话,等待登录 Bearer(打开/刷新 designarena.ai 登录后自动补上)</div>';
  var r = cur.result;
  if (!r) return '<div class="dim">记录异常</div>';
  var html = '<div class="dim">已自动反查 @ ' + esc((cur.at || '').slice(11, 19)) + ' · 线索 ' + (r.totalHints || 0) + ' 条</div>';
  (r.agents || []).forEach(function (a) {
    html += '<div style="margin-top:6px"><span class="tag">' + esc(a.id) + '</span> ' +
      '<span class="dim">status ' + (a.statusHttp || '?') + ' · sp ' + (a.spHttp || '?') + ' · tools ' + (a.toolCount != null ? a.toolCount : '?') + '</span>';
    if (a.spHints && a.spHints.length) {
      html += '<br>系统提示词提及: <span class="hit">' + esc(a.spHints.join(', ')) + '</span>';
    }
    if (a.spHead) html += '<pre>' + esc(a.spHead) + '</pre>';
    html += '</div>';
  });
  var evHits = (r.eventKnown || []).concat(r.eventHints || []);
  if (evHits.length) {
    html += '<div style="margin-top:6px">事件流线索:<br><span class="hit">' + esc(evHits.slice(0, 15).join(' ｜ ')) + '</span></div>';
  }
  if ((r.totalHints || 0) === 0) html += '<div class="dim">未发现明显模型线索(可点右下角“重新反查”再试)</div>';
  return html;
}

function render() {
  var b = state.bearer;
  if (b) {
    $('bearer-box').innerHTML = '<span class="hit">' + esc(b.masked) + '</span>' +
      '<br><span class="dim">' + esc(b.email || b.uid || '匿名') + ' · ' + esc(b.at) + '</span>';
    $('bearer-exp').textContent = b.exp ? fmtExp(b.exp) : '';
    $('btn-copy-bearer').disabled = false;
  }
  var p = state.pubTokens[0];
  if (p) {
    $('pub-box').innerHTML = '<span class="hit">' + esc(p.masked) + '</span>' +
      '<br><span class="dim">' + fmtExp(p.exp) + '</span>';
    $('btn-copy-pub').disabled = false;
    $('btn-probe-pub').disabled = false;
  }
  renderAutoArena();
  var box = $('sessions');
  if (state.sessions.length === 0) {
    box.textContent = '暂无。在网页端(mode=pro / agent)发起一次生成,这里会自动出结果。';
    box.className = 'dim';
  } else {
    box.className = '';
    box.innerHTML = state.sessions.slice(0, 10).map(function (s) {
      var agents = (s.agents || []).map(function (a) { return '<span class="tag">' + esc(a) + '</span>'; }).join('');
      return '<div class="session" data-sid="' + esc(s.id) + '">' +
        '<div class="sid">' + esc(s.id) + '</div>' +
        '<div class="dim">' + esc(s.at) + '</div>' +
        '<div>' + (agents || '<span class="dim">(未采集到 agents 列表)</span>') + '</div>' +
        '<div class="hintbox" id="hint-' + esc(s.id) + '">' + renderSessionAuto(s.id) + '</div>' +
        '<div class="row"><button class="btn-probe" data-sid="' + esc(s.id) + '">↻ 重新反查</button>' +
        '<a href="https://www.designarena.ai/chat/' + encodeURIComponent(s.id) + '" target="_blank" style="color:#7b8aa0;font-size:11px">试探聊天页</a></div>' +
        '</div>';
    }).join('');
  }
  var log = $('log');
  if (state.log.length === 0) { log.textContent = '(空)'; }
  else {
    log.innerHTML = state.log.slice(-25).reverse().map(function (l) {
      return '<div><span class="dim">' + esc(l.at.slice(11, 19)) + '</span> ' + esc(l.text) + '</div>';
    }).join('');
  }
}

function copyText(t, btn) {
  navigator.clipboard.writeText(t).then(function () {
    var old = btn.textContent; btn.textContent = '已复制✓';
    setTimeout(function () { btn.textContent = old; }, 1200);
  });
}

function renderAgentHints(target, res) {
  if (!res || !res.ok) { target.innerHTML = '<span class="dim">' + esc((res && res.error) || '失败') + '</span>'; return; }
  target.innerHTML = renderSessionAuto(res.sessionId);
  if (!target.innerHTML) {
    var html = '';
    (res.agents || []).forEach(function (a) {
      html += '<div style="margin-top:6px"><span class="tag">' + esc(a.id) + '</span> ';
      html += '<span class="dim">status ' + (a.statusHttp || '?') + ' · sp ' + (a.spHttp || '?') + ' · tools ' + (a.toolCount != null ? a.toolCount : '?') + '</span>';
      if (a.spHints && a.spHints.length) html += '<br>系统提示词提及: <span class="hit">' + esc(a.spHints.join(', ')) + '</span>';
      if (a.spHead) html += '<pre>' + esc(a.spHead) + '</pre>';
      html += '</div>';
    });
    var evHits = (res.eventKnown || []).concat(res.eventHints || []);
    if (evHits.length) html += '<div style="margin-top:6px">事件流线索:<br><span class="hit">' + esc(evHits.slice(0, 15).join(' ｜ ')) + '</span></div>';
    target.innerHTML = html || '<span class="dim">未发现明显身份线索</span>';
  }
}

function bind() {
  $('btn-copy-bearer').addEventListener('click', function () {
    if (state.bearer) copyText(state.bearer.token, this);
  });
  $('btn-copy-pub').addEventListener('click', function () {
    if (state.pubTokens[0]) copyText(state.pubTokens[0].token, this);
  });
  $('btn-probe-pub').addEventListener('click', function () {
    var out = $('pub-auto');
    out.innerHTML = '<span class="dim">重新探测 Trigger.dev 中…</span>';
    var self = this; self.disabled = true;
    send({ type: 'popup:probe-arena-token' }).then(function (res) {
      self.disabled = false;
      if (!res.ok) { out.innerHTML = '<span class="dim">' + esc(res.error || '失败') + '</span>'; return; }
      var html = '<div class="dim">runId: ' + esc(res.runId) + '(刚刚重探)</div>';
      (res.attempts || []).forEach(function (a) {
        html += '<div class="dim">' + esc(a.path) + ' → HTTP ' + a.status + '</div>';
        var hits = (a.known || []).concat(a.hints || []);
        if (hits.length) html += '<div class="hit">' + esc(hits.slice(0, 12).join(' ｜ ')) + '</div>';
        if (a.preview) html += '<pre>' + esc(a.preview) + '</pre>';
      });
      out.innerHTML = html;
    });
  });
  $('sessions').addEventListener('click', function (ev) {
    var btn = ev.target.closest('.btn-probe');
    if (!btn) return;
    var sid = btn.getAttribute('data-sid');
    var target = $('hint-' + sid);
    target.innerHTML = '<span class="dim">重新反查中(status / system-prompt / tools / events)…</span>';
    btn.disabled = true;
    send({ type: 'popup:probe-session', sessionId: sid }).then(function (res) {
      btn.disabled = false;
      renderAgentHints(target, res);
    });
  });
  $('btn-export').addEventListener('click', function () {
    var exportData = {
      bearer: state.bearer ? { masked: state.bearer.masked, at: state.bearer.at, exp: state.bearer.exp, email: state.bearer.email } : null,
      pubTokens: state.pubTokens.map(function (t) { return { masked: t.masked, at: t.at, exp: t.exp }; }),
      sessions: state.sessions,
      autoSessions: state.autoSessions,
      autoArena: state.autoArena,
      log: state.log
    };
    var blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'designarena-probe-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });
  $('btn-clear').addEventListener('click', function () {
    if (!confirm('确定清空所有捕获数据?')) return;
    send({ type: 'popup:clear' }).then(load);
  });
}

function load() {
  send({ type: 'popup:get-state' }).then(function (res) {
    if (res.ok) { state = res; render(); }
  });
}

document.addEventListener('DOMContentLoaded', function () {
  bind();
  load();
});
