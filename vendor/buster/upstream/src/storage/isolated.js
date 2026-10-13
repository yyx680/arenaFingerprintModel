// SPDX-License-Identifier: GPL-3.0-only
// Vodka embedding adapter: never clear or migrate the host extension's storage.
const PREFIX = 'amp.buster.v1.';
const wrapKeys = keys => typeof keys === 'string' ? PREFIX + keys : keys.map(key => PREFIX + key);
function areaAdapter(name) {
  const raw = () => { const area=browser.storage?.[name]; if(!area)throw Error('Storage API unavailable in this context'); return area; };
  return {
    async get(keys = null) {
      let query = keys;
      if (typeof keys === 'string' || Array.isArray(keys)) query = wrapKeys(keys);
      else if (keys && typeof keys === 'object') query = Object.fromEntries(Object.entries(keys).map(([k,v]) => [PREFIX+k,v]));
      const data = await raw().get(query);
      return Object.fromEntries(Object.entries(data).filter(([key]) => key.startsWith(PREFIX)).map(([key,value]) => [key.slice(PREFIX.length),value]));
    },
    set(data) { return raw().set(Object.fromEntries(Object.entries(data).map(([k,v]) => [PREFIX+k,v]))); },
    remove(keys) { return raw().remove(wrapKeys(keys)); },
    async clear() { const own = Object.keys(await raw().get(null)).filter(key => key.startsWith(PREFIX)); if (own.length) await raw().remove(own); },
    async getBytesInUse(keys = null) { const own = keys === null ? Object.keys(await raw().get(null)).filter(key => key.startsWith(PREFIX)) : wrapKeys(keys); return raw().getBytesInUse(own); }
  };
}
const callbacks = new Map();
const onChanged = {
  addListener(callback) {
    if (callbacks.has(callback)) return;
    const wrapped = (changes,area) => {
      const own = Object.fromEntries(Object.entries(changes).filter(([key]) => key.startsWith(PREFIX)).map(([key,value]) => [key.slice(PREFIX.length),value]));
      if (Object.keys(own).length) callback(own,area);
    };
    callbacks.set(callback,wrapped); browser.storage.onChanged.addListener(wrapped);
  },
  removeListener(callback) { const wrapped = callbacks.get(callback); if (wrapped) { browser.storage.onChanged.removeListener(wrapped); callbacks.delete(callback); } },
  hasListener(callback) { return callbacks.has(callback); }
};
export const busterStorage = {local:areaAdapter('local'),session:areaAdapter('session'),sync:areaAdapter('sync'),onChanged};
