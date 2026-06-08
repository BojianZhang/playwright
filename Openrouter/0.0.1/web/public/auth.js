'use strict';
// 客户端访问令牌助手:给所有请求带上 token；遇到 401 弹窗输入并记住(localStorage)。
(function () {
  window.OR_TOKEN = localStorage.getItem('or_token') || '';

  // 给 URL 追加 ?token=(用于 EventSource / 下载 等不便加请求头的场景)
  window.withToken = function (u) {
    if (!window.OR_TOKEN) return u;
    return u + (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(window.OR_TOKEN);
  };

  // 带令牌的 fetch;若 401 则提示输入 token 后重试。
  window.authFetch = async function (u, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, window.OR_TOKEN ? { 'X-Auth-Token': window.OR_TOKEN } : {});
    let r = await fetch(u, opts);
    if (r.status === 401) {
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
