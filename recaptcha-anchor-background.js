// SPDX-License-Identifier: GPL-3.0-only
// One checkbox activation per visible Arena reCAPTCHA anchor document.
const ENABLED_KEY = 'amp.buster.v1.autoCaptchaEnabled';
const CLAIMS_KEY = 'amp.buster.v1.anchorAttemptClaims';
const ARENA = /^https:\/\/(?:canary\.)?arena\.ai(?:\/|$)/;
let registered = false;
let claimQueue = Promise.resolve();

function isAnchor(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      ['google.com', 'www.google.com', 'recaptcha.net', 'www.recaptcha.net'].includes(url.hostname) &&
      /^\/recaptcha\/(?:api2|enterprise)\/anchor$/.test(url.pathname);
  } catch { return false; }
}

async function claimAnchor(sender) {
  if (!Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.frameId) ||
      sender.frameId <= 0 || !ARENA.test(sender.tab.url || '') || !isAnchor(sender.url)) {
    return {allowed: false, reason: 'unsupportedFrame'};
  }
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!tab.active || !ARENA.test(tab.url || '')) return {allowed: false, reason: 'notVisible'};
  const windowState = await chrome.windows.get(tab.windowId);
  if (!windowState.focused) return {allowed: false, reason: 'notVisible'};
  const frame = await chrome.webNavigation.getFrame({tabId: tab.id, frameId: sender.frameId});
  if (!frame || frame.errorOccurred || frame.url !== sender.url ||
      (sender.documentId && frame.documentId !== sender.documentId)) {
    return {allowed: false, reason: 'staleFrame'};
  }
  const parent = await chrome.tabs.sendMessage(tab.id, {
    type: 'AMP_RECAPTCHA_ANCHOR_VISIBLE', anchorUrl: sender.url
  }, {frameId: 0});
  if (parent?.visible !== true) return {allowed: false, reason: 'notVisible'};
  const preferences = await chrome.storage.local.get(ENABLED_KEY);
  if (preferences[ENABLED_KEY] !== true) return {allowed: false, reason: 'disabled'};
  const state = await chrome.storage.session.get(CLAIMS_KEY);
  const claims = state[CLAIMS_KEY] || {};
  const key = String(tab.id) + ':' + (sender.documentId || String(sender.frameId) + ':' + sender.url);
  if (Object.prototype.hasOwnProperty.call(claims, key)) return {allowed: false, reason: 'alreadyAttempted'};
  if (Object.keys(claims).length >= 64) return {allowed: false, reason: 'sessionLimit'};
  claims[key] = true;
  await chrome.storage.session.set({[CLAIMS_KEY]: claims});
  return {allowed: true};
}

export function registerRecaptchaAnchor() {
  if (registered) return;
  registered = true;
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== 'AMP_RECAPTCHA_ANCHOR_CLAIM' || sender.id !== chrome.runtime.id) return;
    const result = claimQueue.then(() => claimAnchor(sender));
    claimQueue = result.then(() => {}, () => {});
    result.then(reply, () => reply({allowed: false, reason: 'unavailable'}));
    return true;
  });
}
