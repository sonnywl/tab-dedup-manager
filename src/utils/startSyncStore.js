// https://github.com/tdriley/webext-sync/blob/main/src/index.js

function isObject(item) {
  return item && typeof item === "object" && !Array.isArray(item);
}

function deepMerge(target, ...sources) {
  if (!sources.length) return target;
  const source = sources.shift();

  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        deepMerge(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }
  return deepMerge(target, ...sources);
}

if (!("browser" in self)) self.browser = self.chrome;

const localStorage = browser.storage.local;

const get = async (key) => {
  const state = (await (!key || !key.length))
    ? localStorage.get(null)
    : localStorage.get(key);
  return state || {};
};

const set = async (data) => {
  await localStorage.set(data);
  return data;
};

export default async function startSyncStore(defaultState = {}) {
  const prevState = await get();
  await set(deepMerge(defaultState, prevState));
  let prevHandler;

  return {
    onChange: (fn) => {
      if (prevHandler) browser.storage.onChanged.removeListener(prevHandler);

      const handler = async (changes, area) => {
        const state = await get();
        const prevState = {};

        for (const item in changes) {
          prevState[item] = changes[item].oldValue;
        }

        fn(state, prevState);
      };
      prevHandler = handler;
      browser.storage.onChanged.addListener(handler);
    },
    getState: get,
    setState: set,
  };
}
