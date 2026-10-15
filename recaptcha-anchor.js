// SPDX-License-Identifier: GPL-3.0-only
// Activate the checkbox only; validation and challenges remain reCAPTCHA's responsibility.
(() => {
  if (globalThis.__ampRecaptchaAnchor) return;
  globalThis.__ampRecaptchaAnchor = true;
  const ENABLED_KEY = 'amp.buster.v1.autoCaptchaEnabled';
  let enabled = false, attempted = false, pending = false, preferenceEpoch = 0;
  let timer = null, observer = null, nextCheckAt = 0;

  function checkbox() {
    const node = document.querySelector('#recaptcha-anchor[role="checkbox"]');
    if (!node || document.visibilityState !== 'visible' ||
        node.getAttribute('aria-checked') !== 'false' ||
        node.getAttribute('aria-disabled') === 'true' || node.getAttribute('aria-busy') === 'true') return null;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 ||
        rect.top >= innerHeight || rect.left >= innerWidth) return null;
    for (let current = node; current instanceof Element; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
    }
    return node;
  }

  function stopWatch() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    observer?.disconnect();
    observer = null;
  }

  async function check() {
    if (!enabled || attempted || pending || Date.now() < nextCheckAt) return;
    if (document.querySelector('#recaptcha-anchor')?.getAttribute('aria-checked') === 'true') {
      attempted = true;
      stopWatch();
      return;
    }
    const node = checkbox();
    if (!node) return;
    pending = true;
    nextCheckAt = Date.now() + 1000;
    try {
      const epoch = preferenceEpoch;
      const state = await chrome.runtime.sendMessage({type: 'AMP_RECAPTCHA_ANCHOR_CLAIM'});
      if (state?.allowed !== true) {
        if (state?.reason === 'notVisible' || state?.reason === 'disabled') return;
        attempted = true;
        stopWatch();
        return;
      }
      // Consume only once, even when the user changes tabs/settings before this response arrives.
      attempted = true;
      stopWatch();
      const preferences = await chrome.storage.local.get(ENABLED_KEY);
      if (preferences[ENABLED_KEY] !== true || !enabled || preferenceEpoch !== epoch || checkbox() !== node) return;
      node.click(); // Ordinary DOM activation; no trusted-event spoofing or debugger permission.
    } catch {
      attempted = true;
      stopWatch(); // No automatic retry after an uncertain result.
    } finally { pending = false; }
  }

  function configure() {
    if (!enabled || attempted) { stopWatch(); return; }
    if (!observer) {
      observer = new MutationObserver(() => void check());
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['aria-checked', 'aria-disabled', 'aria-busy', 'style', 'class', 'hidden']
      });
    }
    if (timer === null) timer = setInterval(() => void check(), 1000);
    void check();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[ENABLED_KEY]) return;
    preferenceEpoch++;
    enabled = changes[ENABLED_KEY].newValue === true;
    configure();
  });
  document.addEventListener('visibilitychange', () => void check());
  window.addEventListener('pagehide', () => { enabled = false; stopWatch(); });
  window.addEventListener('pageshow', () => {
    const epoch = preferenceEpoch;
    chrome.storage.local.get(ENABLED_KEY).then(values => {
      if (epoch !== preferenceEpoch) return;
      enabled = values[ENABLED_KEY] === true;
      configure();
    }).catch(() => {});
  });
  const epoch = preferenceEpoch;
  chrome.storage.local.get(ENABLED_KEY).then(values => {
    if (epoch !== preferenceEpoch) return;
    enabled = values[ENABLED_KEY] === true;
    configure();
  }).catch(() => {});
})();
