'use strict';
// 客户端访问令牌助手:给所有请求带上 token；遇到 401 弹窗输入并记住(localStorage)。
(function () {
  // 支持从网址 ?token=xxx 带入(首次访问/全锁定模式),带入后记住并清理 URL。
  try {
    const usp = new URLSearchParams(location.search);
    const t = usp.get('token');
    if (t) {
      localStorage.setItem('or_token', t.trim());
      usp.delete('token');
      const clean = location.pathname + (usp.toString() ? '?' + usp.toString() : '') + location.hash;
      history.replaceState(null, '', clean);
    }
  } catch (_e) { /* ignore */ }
  window.OR_TOKEN = localStorage.getItem('or_token') || '';

  // 给 URL 追加 ?token=(用于 EventSource / 下载 等不便加请求头的场景)
  window.withToken = function (u) {
    if (!window.OR_TOKEN) return u;
    return u + (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(window.OR_TOKEN);
  };

  // 带令牌的 fetch;若 401 且 silent!==true 才弹窗提示输入 token 后重试。
  // silent=true 用于后台自动刷新,避免反复弹框。
  window.authFetch = async function (u, opts, silent) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, window.OR_TOKEN ? { 'X-Auth-Token': window.OR_TOKEN } : {});
    let r = await fetch(u, opts);
    if (r.status === 401 && silent !== true) {
      const t = prompt('需要访问令牌(token):');
      if (t) {
        window.OR_TOKEN = t.trim();
        localStorage.setItem('or_token', window.OR_TOKEN);
        opts.headers['X-Auth-Token'] = window.OR_TOKEN;
        r = await fetch(u, opts);
      }
    }
    return r;
  };
})();
