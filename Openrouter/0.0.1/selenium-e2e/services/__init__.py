# services/ —— 外部服务封装包(被入口/steps/cardbind 以 `from services import xxx` 导入)
#   adspower_env  AdsPower 环境创建/切代理/删除
#   captcha       Turnstile / hCaptcha 求解(2captcha)
#   firstmail     Firstmail 邮箱取验证码/魔法链接
#   cdp_fetch     CDP Fetch 拦截(过 Turnstile api.js)
#   cdp_raw       裸 CDP 通道(Fix C 用)
