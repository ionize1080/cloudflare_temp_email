export function createTurnstileLoader(browser = window, doc = document) {
  let pending;
  return function loadTurnstile() {
    // Named DOM elements also appear on window; only the actual API is ready.
    if (typeof browser.turnstile?.render === 'function') return Promise.resolve();
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      const finish = error => {
        clearTimeout(timer);
        delete browser.ionacsTurnstileReady;
        if (error) { script.remove(); reject(error); } else resolve();
      };
      const failed = () => finish(new Error('人机验证加载失败，请检查网络后重试'));
      const timer = setTimeout(failed, 20000);
      browser.ionacsTurnstileReady = () => typeof browser.turnstile?.render === 'function' ? finish() : failed();
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=ionacsTurnstileReady';
      script.async = true;
      script.onerror = failed;
      doc.head.append(script);
    }).catch(error => { pending = undefined; throw error; });
    return pending;
  };
}
