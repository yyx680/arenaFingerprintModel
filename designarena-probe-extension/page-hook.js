/* DesignArena 探针 - 页面主世界钩子
 * 包裹 window.fetch / XHR,只读捕获 /api/* 请求的头与 JSON 响应摘要,
 * 通过 window.postMessage 交给隔离世界的 content.js。不修改任何业务行为。 */
(function () {
  'use strict';
  if (window.__daProbeHooked) return;
  window.__daProbeHooked = true;

  function post(payload) {
    try { window.postMessage(Object.assign({ __daprobe: 1 }, payload), location.origin); } catch (e) {}
  }

  function readAuthFrom(init, input) {
    try {
      var h = null;
      if (init && init.headers) h = new Headers(init.headers);
      else if (input && input.headers) h = new Headers(input.headers);
      if (!h) return '';
      return h.get('authorization') || h.get('Authorization') || '';
    } catch (e) { return ''; }
  }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var p = origFetch.apply(this, arguments);
    Promise.resolve(p).then(function (res) {
      try {
        var url = (typeof input === 'string') ? input : (input && input.url) || '';
        if (url.indexOf('/api/') < 0) return;
        var method = (init && init.method) || (input && input.method) || 'GET';
        var info = {
          kind: 'fetch', url: url, method: method, status: res.status,
          auth: readAuthFrom(init, input),
          pubToken: res.headers.get('public-access-token') || res.headers.get('x-public-access-token') || ''
        };
        var ct = res.headers.get('content-type') || '';
        if (ct.indexOf('application/json') >= 0 && res.clone) {
          res.clone().json().then(function (j) {
            var bi = { keys: Object.keys(j || {}) };
            if (j && j.session_id) bi.sessionId = String(j.session_id);
            if (j && Array.isArray(j.agents)) {
              bi.agents = j.agents.map(function (a) {
                return (a && (a.model_id || a.id)) ? String(a.model_id || a.id) : String(a);
              }).slice(0, 12);
            }
            if (j && typeof j.success !== 'undefined') bi.success = !!j.success;
            info.bodyInfo = bi;
            post(info);
          }).catch(function () { post(info); });
        } else {
          post(info);
        }
      } catch (e) {}
    }).catch(function () {});
    return p;
  };

  var oOpen = XMLHttpRequest.prototype.open;
  var oSet = XMLHttpRequest.prototype.setRequestHeader;
  var oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__da = { url: String(u || ''), method: String(m || 'GET'), auth: '' };
    return oOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (this.__da && /^authorization$/i.test(k)) this.__da.auth = String(v); } catch (e) {}
    return oSet.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    if (this.__da && this.__da.url.indexOf('/api/') >= 0) {
      this.addEventListener('loadend', function () {
        try {
          var pub = '';
          try { pub = self.getResponseHeader('public-access-token') || ''; } catch (e) {}
          post({ kind: 'xhr', url: self.__da.url, method: self.__da.method, status: self.status, auth: self.__da.auth || '', pubToken: pub });
        } catch (e) {}
      });
    }
    return oSend.apply(this, arguments);
  };
})();
