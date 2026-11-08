/* DesignArena 探针 - 隔离世界 content script:注入 MAIN 钩子并中转消息 */
(function () {
  'use strict';
  function inject() {
    try {
      var s = document.createElement('script');
      s.src = chrome.runtime.getURL('page-hook.js');
      s.onload = function () { s.remove(); };
      (document.documentElement || document.head || document.body).appendChild(s);
    } catch (e) {}
  }
  inject();

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || !e.data.__daprobe) return;
    try { chrome.runtime.sendMessage({ type: 'daprobe:hook', payload: e.data }, function () { void chrome.runtime.lastError; }); } catch (err) {}
  });
})();
