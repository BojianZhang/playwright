'use strict';

const crypto = require('crypto');

const DEFAULT_HARDENING_POLICY = Object.freeze({
  enabled: true,
  canvas: true,
  webgl: true,
  audio: true,
  navigator: true,
  screen: true,
  webrtc: true,
  plugins: true,
  fonts: true,
  clientRects: true,
  mediaDevices: true,
  permissions: true,
  userAgentData: true,
});

const GPU_PROFILES = Object.freeze([
  {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (AMD)',
    renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
]);

const HARDWARE_CONCURRENCY = Object.freeze([4, 6, 8, 12, 16]);
const DEVICE_MEMORY = Object.freeze([4, 8, 16]);
const COLOR_DEPTHS = Object.freeze([24, 30, 32]);
const FONT_PROFILES = Object.freeze([
  ['Arial', 'Calibri', 'Cambria', 'Consolas', 'Courier New', 'Georgia', 'Segoe UI', 'Times New Roman', 'Verdana'],
  ['Arial', 'Calibri', 'Consolas', 'Courier New', 'Georgia', 'Microsoft YaHei', 'Segoe UI', 'SimSun', 'Verdana'],
  ['Arial', 'Helvetica', 'Menlo', 'Monaco', 'Times New Roman', 'Verdana'],
]);
const PERMISSION_STATES = Object.freeze(['prompt', 'denied']);
const WEBRTC_MODES = Object.freeze(['filter-host-candidates', 'proxy', 'disabled']);

function hashText(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function stableNumber(seed = '', label = '', modulo = 1) {
  const safeModulo = Math.max(1, Number(modulo) || 1);
  const chunk = hashText(`${seed}:${label}`).slice(0, 12);
  return Number.parseInt(chunk, 16) % safeModulo;
}

function stablePick(list = [], seed = '', label = '', fallback = null) {
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!items.length) return fallback;
  return items[stableNumber(seed, label, items.length)] ?? fallback;
}

function stableFloat(seed = '', label = '', min = 0, max = 1, digits = 8) {
  const raw = stableNumber(seed, label, 1000000) / 1000000;
  return Number((Number(min) + raw * (Number(max) - Number(min))).toFixed(digits));
}

function normalizeHardeningPolicy(runtime = {}, options = {}) {
  const rawInput = (
    options?.fingerprintHardening
    || runtime?.fingerprintHardening
    || runtime?.browserIdentity?.fingerprintHardening
    || {}
  );
  const input = typeof rawInput === 'string'
    ? { webrtcMode: rawInput }
    : rawInput;
  const policy = {
    ...DEFAULT_HARDENING_POLICY,
    ...(input && typeof input === 'object' ? input : {}),
  };

  if (runtime?.enableFingerprintHardening === false || options?.enableFingerprintHardening === false) {
    policy.enabled = false;
  }

  for (const key of Object.keys(DEFAULT_HARDENING_POLICY)) {
    policy[key] = Boolean(policy[key]);
  }
  if (rawInput && typeof rawInput === 'object' && typeof rawInput.webrtc === 'string') {
    policy.webrtc = true;
  }
  return policy;
}

function parseLanguages(acceptLanguage = '', locale = '') {
  const langs = String(acceptLanguage || '')
    .split(',')
    .map((item) => item.trim().split(';')[0].trim())
    .filter(Boolean);
  if (locale && !langs.includes(locale)) langs.unshift(String(locale));
  if (!langs.length) langs.push('en-US', 'en');
  const withBase = [];
  for (const lang of langs) {
    if (!withBase.includes(lang)) withBase.push(lang);
    const base = lang.split('-')[0];
    if (base && base !== lang && !withBase.includes(base)) withBase.push(base);
  }
  return withBase.slice(0, 4);
}

function resolvePlatform(userAgent = '') {
  const ua = String(userAgent || '');
  if (/Macintosh|Mac OS X/i.test(ua)) return 'MacIntel';
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return 'Linux x86_64';
  if (/Android/i.test(ua)) return 'Linux armv8l';
  if (/iPhone|iPad/i.test(ua)) return 'iPhone';
  return 'Win32';
}

function resolveUserAgentDataPlatform(platform = '') {
  if (/Mac/i.test(platform)) return 'macOS';
  if (/Linux/i.test(platform)) return 'Linux';
  if (/iPhone|iPad/i.test(platform)) return 'iOS';
  return 'Windows';
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function parseChromeVersion(value = '') {
  const text = String(value || '').trim();
  if (!text) return null;
  let match = text.match(/(?:Chrome|Chromium)\/(\d+)(?:\.(\d+)\.(\d+)\.(\d+))?/i);
  if (!match) match = text.match(/^(\d+)(?:\.(\d+)\.(\d+)\.(\d+))?$/);
  if (!match) return null;
  const major = match[1];
  if (!/^\d+$/.test(major)) return null;
  return {
    major,
    fullVersion: [major, match?.[2] || '0', match?.[3] || '0', match?.[4] || '0'].join('.'),
  };
}

function resolveChromeVersion(userAgent = '', runtime = {}) {
  const userAgentData = runtime?.userAgentData && typeof runtime.userAgentData === 'object'
    ? runtime.userAgentData
    : {};
  const explicitFullVersion = firstString(
    runtime?.chromeFullVersion,
    runtime?.browserFullVersion,
    runtime?.userAgentFullVersion,
    runtime?.fullVersion,
    userAgentData.uaFullVersion,
    userAgentData.fullVersion,
  );
  const fromExplicitFull = parseChromeVersion(explicitFullVersion);
  if (fromExplicitFull) return { ...fromExplicitFull, source: 'runtime-full-version' };

  const explicitMajor = firstString(
    runtime?.chromeMajor,
    runtime?.browserMajorVersion,
    runtime?.userAgentMajorVersion,
  );
  if (/^\d+$/.test(explicitMajor)) {
    return {
      major: explicitMajor,
      fullVersion: `${explicitMajor}.0.0.0`,
      source: 'runtime-major-version',
    };
  }

  const fromUserAgent = parseChromeVersion(userAgent);
  return fromUserAgent ? { ...fromUserAgent, source: 'user-agent' } : null;
}

function normalizeBrandList(list = [], version = '') {
  if (!Array.isArray(list) || !list.length) return null;
  const out = list
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const brand = String(item.brand || '').trim();
      const itemVersion = String(item.version || version || '').trim();
      return brand && itemVersion ? { brand, version: itemVersion } : null;
    })
    .filter(Boolean);
  return out.length ? out : null;
}

function buildDefaultBrandList(version = '', options = {}) {
  const notABrandVersion = options.fullVersionList ? '99.0.0.0' : '99';
  return [
    { brand: 'Not.A/Brand', version: notABrandVersion },
    { brand: 'Chromium', version: String(version) },
    { brand: 'Google Chrome', version: String(version) },
  ];
}

function buildUserAgentData(fingerprint = {}, platform = 'Win32', runtime = {}) {
  if (runtime?.userAgentData === false || runtime?.clientHints === false) return null;
  const override = runtime?.userAgentData && typeof runtime.userAgentData === 'object'
    ? runtime.userAgentData
    : (runtime?.clientHints && typeof runtime.clientHints === 'object' ? runtime.clientHints : {});
  const chrome = resolveChromeVersion(fingerprint?.userAgent, runtime);
  if (!chrome && !Object.keys(override).length) return null;

  const fullVersion = firstString(
    override.uaFullVersion,
    override.fullVersion,
    chrome?.fullVersion,
  );
  const major = firstString(
    chrome?.major,
    String(fullVersion || '').split('.')[0],
  );
  if (!/^\d+$/.test(major) || !fullVersion) return null;

  const uaPlatform = String(override.platform || resolveUserAgentDataPlatform(platform));
  const userAgent = String(fingerprint?.userAgent || '');
  const brands = normalizeBrandList(override.brands, major) || buildDefaultBrandList(major);
  const fullVersionList = normalizeBrandList(override.fullVersionList, fullVersion) || buildDefaultBrandList(fullVersion, { fullVersionList: true });
  return {
    brands,
    fullVersionList,
    mobile: override.mobile !== undefined ? Boolean(override.mobile) : /Android|iPhone|iPad/i.test(userAgent),
    platform: uaPlatform,
    architecture: String(override.architecture ?? (uaPlatform === 'Windows' || uaPlatform === 'Linux' ? 'x86' : '')),
    bitness: String(override.bitness ?? (uaPlatform === 'Windows' || uaPlatform === 'Linux' ? '64' : '')),
    model: String(override.model || ''),
    platformVersion: String(override.platformVersion ?? (uaPlatform === 'Windows' ? '10.0.0' : '')),
    uaFullVersion: fullVersion,
    fullVersion,
    wow64: Boolean(override.wow64),
  };
}

function normalizeWebrtcMode(value = '', fallback = 'filter-host-candidates') {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return fallback;
  if (text === 'filter' || text === 'filter-host' || text === 'filter_host_candidates') return 'filter-host-candidates';
  if (text === 'proxy') return 'proxy';
  if (text === 'disable' || text === 'disabled' || text === 'block' || text === 'blocked' || text === 'none') return 'disabled';
  return WEBRTC_MODES.includes(text) ? text : fallback;
}

function resolveWebrtcMode(runtime = {}, options = {}) {
  const rawHardening = (
    options?.fingerprintHardening
    || runtime?.fingerprintHardening
    || runtime?.browserIdentity?.fingerprintHardening
    || {}
  );
  const hardening = rawHardening && typeof rawHardening === 'object' ? rawHardening : {};
  const candidates = [
    options?.webrtcMode,
    runtime?.webrtcMode,
    runtime?.webrtc && typeof runtime.webrtc === 'object' ? runtime.webrtc.mode : '',
    hardening?.webrtcMode,
    hardening?.webrtc && typeof hardening.webrtc === 'object' ? hardening.webrtc.mode : '',
    typeof hardening?.webrtc === 'string' ? hardening.webrtc : '',
    typeof rawHardening === 'string' ? rawHardening : '',
  ];
  for (const candidate of candidates) {
    const mode = normalizeWebrtcMode(candidate, '');
    if (mode) return mode;
  }
  return 'filter-host-candidates';
}

function buildMediaDevices(seed = '') {
  const groupId = hashText(`${seed}:media-group`).slice(0, 32);
  const specs = [
    ['audioinput', ''],
    ['audiooutput', ''],
    ['videoinput', ''],
  ];
  return specs.map(([kind, label], index) => ({
    kind,
    label,
    deviceId: hashText(`${seed}:media-device:${kind}:${index}`).slice(0, 32),
    groupId,
  }));
}

function buildPermissionStates(seed = '') {
  return {
    notifications: stablePick(PERMISSION_STATES, seed, 'permission-notifications', 'prompt'),
    geolocation: 'prompt',
    camera: 'prompt',
    microphone: 'prompt',
    midi: 'prompt',
  };
}

function buildFingerprintHardeningProfile(fingerprint = {}, options = {}) {
  const runtime = options?.runtime && typeof options.runtime === 'object' ? options.runtime : {};
  const policy = normalizeHardeningPolicy(runtime, options);
  const identitySeed = (
    options?.seed
    || fingerprint?.identity?.identitySeed
    || fingerprint?.summary?.identitySeed
    || 'browser-runtime'
  );
  const seed = hashText([
    identitySeed,
    fingerprint?.identity?.identityHash || '',
    fingerprint?.locale || '',
    fingerprint?.timezoneId || '',
  ].join('|'));
  const viewport = fingerprint?.viewport && typeof fingerprint.viewport === 'object'
    ? fingerprint.viewport
    : { width: 1366, height: 768 };
  const languages = parseLanguages(fingerprint?.acceptLanguage, fingerprint?.locale);
  const platform = String(runtime?.platform || resolvePlatform(fingerprint?.userAgent));
  const gpu = stablePick(GPU_PROFILES, seed, 'webgl', GPU_PROFILES[0]);
  const colorDepth = stablePick(COLOR_DEPTHS, seed, 'screen-depth', 24);
  const userAgentData = buildUserAgentData(fingerprint, platform, runtime);
  const webrtcMode = resolveWebrtcMode(runtime, options);
  const fontProfile = Array.isArray(runtime?.fonts) && runtime.fonts.length
    ? runtime.fonts.map(String).filter(Boolean)
    : stablePick(FONT_PROFILES, seed, 'fonts', FONT_PROFILES[0]);
  const canvasNoise = {
    r: stableNumber(seed, 'canvas-r', 3) + 1,
    g: stableNumber(seed, 'canvas-g', 3) + 1,
    b: stableNumber(seed, 'canvas-b', 3) + 1,
  };
  const clientRectNoise = stableFloat(seed, 'client-rects', 0.01, 0.18, 4);

  return {
    enabled: policy.enabled,
    seedHash: hashText(seed).slice(0, 16),
    policy,
    canvas: {
      enabled: policy.enabled && policy.canvas,
      noise: canvasNoise,
    },
    webgl: {
      enabled: policy.enabled && policy.webgl,
      vendor: runtime?.webglVendor || gpu.vendor,
      renderer: runtime?.webglRenderer || gpu.renderer,
    },
    audio: {
      enabled: policy.enabled && policy.audio,
      noise: stableFloat(seed, 'audio-noise', 0.000001, 0.00002, 8),
    },
    navigator: {
      enabled: policy.enabled && policy.navigator,
      hardwareConcurrency: Number(runtime?.hardwareConcurrency || stablePick(HARDWARE_CONCURRENCY, seed, 'hardware', 8)),
      deviceMemory: Number(runtime?.deviceMemory || stablePick(DEVICE_MEMORY, seed, 'memory', 8)),
      maxTouchPoints: Number(runtime?.maxTouchPoints ?? 0),
      platform,
      vendor: String(runtime?.navigatorVendor || 'Google Inc.'),
      language: languages[0],
      languages,
      plugins: policy.plugins
        ? ['Chrome PDF Plugin', 'Chrome PDF Viewer', 'Native Client']
        : [],
      userAgentData: policy.enabled && policy.userAgentData
        ? userAgentData
        : null,
    },
    screen: {
      enabled: policy.enabled && policy.screen,
      width: Number(runtime?.screenWidth || viewport.width || 1366),
      height: Number(runtime?.screenHeight || viewport.height || 768),
      availWidth: Number(runtime?.screenAvailWidth || viewport.width || 1366),
      availHeight: Number(runtime?.screenAvailHeight || Math.max(0, Number(viewport.height || 768) - 40)),
      colorDepth,
      pixelDepth: colorDepth,
    },
    webrtc: {
      enabled: policy.enabled && policy.webrtc && webrtcMode !== 'disabled',
      mode: webrtcMode,
    },
    fonts: {
      enabled: policy.enabled && policy.fonts,
      list: fontProfile,
      textWidthNoise: stableFloat(seed, 'font-width-noise', 0.01, 0.12, 4),
    },
    clientRects: {
      enabled: policy.enabled && policy.clientRects,
      noise: clientRectNoise,
    },
    mediaDevices: {
      enabled: policy.enabled && policy.mediaDevices,
      devices: buildMediaDevices(seed),
    },
    permissions: {
      enabled: policy.enabled && policy.permissions,
      states: buildPermissionStates(seed),
    },
  };
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function buildFingerprintHardeningInitScript(profile = {}) {
  return `
(() => {
  const profile = ${safeJson(profile)};
  if (!profile || !profile.enabled) return;
  const defineGetter = (target, prop, value) => {
    try {
      Object.defineProperty(target, prop, {
        configurable: true,
        enumerable: true,
        get: () => value,
      });
    } catch (_error) {}
  };
  const clampByte = (value) => Math.max(0, Math.min(255, value));
  const nativeSource = window.__sbrNativeSource || new WeakMap();
  try { Object.defineProperty(window, '__sbrNativeSource', { configurable: true, value: nativeSource }); } catch (_registryError) {}
  const markNative = (fn, name) => {
    if (typeof fn === 'function') nativeSource.set(fn, 'function ' + name + '() { [native code] }');
    return fn;
  };
  try {
    const originalToString = Function.prototype.toString;
    if (!Function.prototype.__sbrNativeToString) {
      Object.defineProperty(Function.prototype, '__sbrNativeToString', { value: true });
      Function.prototype.toString = function toString() {
        return nativeSource.get(this) || originalToString.call(this);
      };
      nativeSource.set(Function.prototype.toString, 'function toString() { [native code] }');
    }
  } catch (_error) {}
  const cloneRect = (rect, noise) => {
    const left = Number(rect.left || 0) + noise;
    const top = Number(rect.top || 0) + noise;
    const width = Number(rect.width || (Number(rect.right || 0) - Number(rect.left || 0)));
    const height = Number(rect.height || (Number(rect.bottom || 0) - Number(rect.top || 0)));
    const right = left + width;
    const bottom = top + height;
    try {
      if (typeof DOMRect === 'function') return new DOMRect(left, top, width, height);
      if (window.DOMRectReadOnly && typeof DOMRectReadOnly.fromRect === 'function') {
        return DOMRectReadOnly.fromRect({ x: left, y: top, width, height });
      }
    } catch (_rectError) {}
    return rect;
  };
  const buildRectList = (nativeList, items) => {
    try {
      const rectList = Object.create(Object.getPrototypeOf(nativeList));
      Object.defineProperty(rectList, 'length', { configurable: true, enumerable: false, value: items.length });
      Object.defineProperty(rectList, 'item', {
        configurable: true,
        enumerable: false,
        value: markNative(function item(index) {
          return items[Number(index)] || null;
        }, 'item'),
      });
      items.forEach((item, index) => {
        Object.defineProperty(rectList, index, { configurable: true, enumerable: true, value: item });
      });
      return rectList;
    } catch (_rectListError) {
      return nativeList;
    }
  };

  if (profile.canvas && profile.canvas.enabled) {
    try {
      const proto = HTMLCanvasElement && HTMLCanvasElement.prototype;
      const ctxProto = CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
      if (proto && ctxProto && !proto.__sbrCanvasHardening) {
        Object.defineProperty(proto, '__sbrCanvasHardening', { value: true });
        const originalToDataURL = proto.toDataURL;
        const originalToBlob = proto.toBlob;
        const originalGetImageData = ctxProto.getImageData;
        const noise = profile.canvas.noise || { r: 1, g: 1, b: 1 };
        const addNoise = (imageData) => {
          const data = imageData && imageData.data;
          if (!data) return imageData;
          for (let i = 0; i < data.length; i += 4) {
            data[i] = clampByte(data[i] + noise.r);
            data[i + 1] = clampByte(data[i + 1] + noise.g);
            data[i + 2] = clampByte(data[i + 2] + noise.b);
          }
          return imageData;
        };
        const withNoisyCanvas = (canvas, fn, args) => {
          let ctx;
          let backup;
          try {
            if (!canvas.width || !canvas.height) return fn.apply(canvas, args);
            ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return fn.apply(canvas, args);
            backup = originalGetImageData.call(ctx, 0, 0, canvas.width, canvas.height);
            const noisy = originalGetImageData.call(ctx, 0, 0, canvas.width, canvas.height);
            addNoise(noisy);
            ctx.putImageData(noisy, 0, 0);
            return fn.apply(canvas, args);
          } catch (_error) {
            return fn.apply(canvas, args);
          } finally {
            try {
              if (ctx && backup) ctx.putImageData(backup, 0, 0);
            } catch (_restoreError) {}
          }
        };
        ctxProto.getImageData = markNative(function getImageData() {
          const imageData = originalGetImageData.apply(this, arguments);
          return addNoise(imageData);
        }, 'getImageData');
        proto.toDataURL = markNative(function toDataURL() {
          return withNoisyCanvas(this, originalToDataURL, arguments);
        }, 'toDataURL');
        proto.toBlob = markNative(function toBlob() {
          return withNoisyCanvas(this, originalToBlob, arguments);
        }, 'toBlob');
      }
    } catch (_error) {}
  }

  if (profile.webgl && profile.webgl.enabled) {
    try {
      const patchWebgl = (proto) => {
        if (!proto || proto.__sbrWebglHardening) return;
        Object.defineProperty(proto, '__sbrWebglHardening', { value: true });
        const originalGetParameter = proto.getParameter;
        proto.getParameter = markNative(function getParameter(parameter) {
          if (parameter === 37445) return profile.webgl.vendor;
          if (parameter === 37446) return profile.webgl.renderer;
          return originalGetParameter.apply(this, arguments);
        }, 'getParameter');
      };
      patchWebgl(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
      patchWebgl(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
    } catch (_error) {}
  }

  if (profile.audio && profile.audio.enabled) {
    try {
      const noise = Number(profile.audio.noise || 0.000001);
      const analyserProto = window.AnalyserNode && AnalyserNode.prototype;
      if (analyserProto && !analyserProto.__sbrAudioHardening) {
        Object.defineProperty(analyserProto, '__sbrAudioHardening', { value: true });
        const originalFloat = analyserProto.getFloatFrequencyData;
        const originalByte = analyserProto.getByteFrequencyData;
        analyserProto.getFloatFrequencyData = markNative(function getFloatFrequencyData(array) {
          const result = originalFloat.apply(this, arguments);
          for (let i = 0; array && i < array.length; i += 1) array[i] += noise;
          return result;
        }, 'getFloatFrequencyData');
        analyserProto.getByteFrequencyData = markNative(function getByteFrequencyData(array) {
          const result = originalByte.apply(this, arguments);
          for (let i = 0; array && i < array.length; i += 1) array[i] = clampByte(array[i] + 1);
          return result;
        }, 'getByteFrequencyData');
      }
      const bufferProto = window.AudioBuffer && AudioBuffer.prototype;
      if (bufferProto && !bufferProto.__sbrAudioBufferHardening) {
        Object.defineProperty(bufferProto, '__sbrAudioBufferHardening', { value: true });
        const originalCopy = bufferProto.copyFromChannel;
        bufferProto.copyFromChannel = markNative(function copyFromChannel(destination) {
          const result = originalCopy.apply(this, arguments);
          for (let i = 0; destination && i < destination.length; i += 100) destination[i] += noise;
          return result;
        }, 'copyFromChannel');
      }
    } catch (_error) {}
  }

  if (profile.fonts && profile.fonts.enabled) {
    try {
      const fonts = Object.freeze([...(profile.fonts.list || [])]);
      const widthNoise = Number(profile.fonts.textWidthNoise || 0);
      const ctxProto = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
      if (ctxProto && !ctxProto.__sbrFontHardening) {
        Object.defineProperty(ctxProto, '__sbrFontHardening', { value: true });
        const originalMeasureText = ctxProto.measureText;
        ctxProto.measureText = markNative(function measureText(text) {
          const metrics = originalMeasureText.apply(this, arguments);
          if (!metrics || !Number.isFinite(metrics.width)) return metrics;
          try {
            return new Proxy(metrics, {
              get(target, prop, receiver) {
                if (prop === 'width') return target.width + widthNoise;
                return Reflect.get(target, prop, receiver);
              },
            });
          } catch (_error) {
            return metrics;
          }
        }, 'measureText');
      }
      const fontSet = document.fonts;
      if (fontSet && !fontSet.__sbrFontSetHardening) {
        Object.defineProperty(fontSet, '__sbrFontSetHardening', { value: true });
        const originalCheck = typeof fontSet.check === 'function' ? fontSet.check.bind(fontSet) : null;
        if (originalCheck) {
          fontSet.check = markNative(function check(font, text) {
            const query = String(font || '').toLowerCase();
            for (const name of fonts) {
              if (query.includes(String(name).toLowerCase())) return true;
            }
            return originalCheck(font, text);
          }, 'check');
        }
      }
    } catch (_error) {}
  }

  if (profile.clientRects && profile.clientRects.enabled) {
    try {
      const noise = Number(profile.clientRects.noise || 0);
      const elementProto = window.Element && Element.prototype;
      if (elementProto && !elementProto.__sbrClientRectHardening) {
        Object.defineProperty(elementProto, '__sbrClientRectHardening', { value: true });
        const originalBounding = elementProto.getBoundingClientRect;
        const originalRects = elementProto.getClientRects;
        elementProto.getBoundingClientRect = markNative(function getBoundingClientRect() {
          const rect = originalBounding.apply(this, arguments);
          return cloneRect(rect, noise);
        }, 'getBoundingClientRect');
        elementProto.getClientRects = markNative(function getClientRects() {
          const rects = originalRects.apply(this, arguments);
          const items = Array.from(rects || []).map((rect) => cloneRect(rect, noise));
          return buildRectList(rects, items);
        }, 'getClientRects');
      }
    } catch (_error) {}
  }

  if (profile.navigator && profile.navigator.enabled) {
    try {
      const navTarget = (window.Navigator && Navigator.prototype) || navigator;
      defineGetter(navTarget, 'hardwareConcurrency', profile.navigator.hardwareConcurrency);
      defineGetter(navTarget, 'deviceMemory', profile.navigator.deviceMemory);
      defineGetter(navTarget, 'maxTouchPoints', profile.navigator.maxTouchPoints);
      defineGetter(navTarget, 'platform', profile.navigator.platform);
      defineGetter(navTarget, 'vendor', profile.navigator.vendor);
      defineGetter(navTarget, 'language', profile.navigator.language);
      defineGetter(navTarget, 'languages', Object.freeze([...(profile.navigator.languages || [])]));
      try { delete navTarget.webdriver; } catch (_deleteProtoError) {}
      try { delete navigator.webdriver; } catch (_deleteOwnError) {}
      defineGetter(navTarget, 'webdriver', undefined);
      if (profile.navigator.plugins && profile.navigator.plugins.length) {
        const pluginArray = {};
        const names = profile.navigator.plugins;
        names.forEach((name, index) => {
          const plugin = {
            name,
            filename: name.replace(/\\s+/g, '_').toLowerCase(),
            description: name,
            length: 0,
          };
          pluginArray[index] = plugin;
          pluginArray[name] = plugin;
        });
        Object.defineProperty(pluginArray, 'length', { value: names.length });
        Object.defineProperty(pluginArray, 'item', { value: markNative(function item(index) { return pluginArray[index] || null; }, 'item') });
        Object.defineProperty(pluginArray, 'namedItem', { value: markNative(function namedItem(name) { return pluginArray[name] || null; }, 'namedItem') });
        Object.defineProperty(pluginArray, 'refresh', { value: markNative(function refresh() { return undefined; }, 'refresh') });
        try { Object.defineProperty(pluginArray, Symbol.toStringTag, { value: 'PluginArray' }); } catch (_tagError) {}
        defineGetter(navTarget, 'plugins', pluginArray);
      }
      if (profile.navigator.userAgentData) {
        const uaData = {
          brands: Object.freeze([...(profile.navigator.userAgentData.brands || [])]),
          mobile: Boolean(profile.navigator.userAgentData.mobile),
          platform: String(profile.navigator.userAgentData.platform || ''),
          getHighEntropyValues: markNative(async function getHighEntropyValues(hints) {
            const source = profile.navigator.userAgentData || {};
            const out = {
              brands: [...(source.brands || [])],
              mobile: Boolean(source.mobile),
              platform: String(source.platform || ''),
            };
            const requested = Array.isArray(hints) ? hints : [];
            for (const hint of requested) {
              if (Object.prototype.hasOwnProperty.call(source, hint)) out[hint] = source[hint];
            }
            if (requested.includes('fullVersionList')) out.fullVersionList = [...(source.fullVersionList || [])];
            return out;
          }, 'getHighEntropyValues'),
          toJSON() {
            return { brands: this.brands, mobile: this.mobile, platform: this.platform };
          },
        };
        try { Object.defineProperty(uaData.toJSON, 'name', { configurable: true, value: 'toJSON' }); } catch (_uaJsonNameError) {}
        markNative(uaData.toJSON, 'toJSON');
        defineGetter(navTarget, 'userAgentData', uaData);
      }
    } catch (_error) {}
  }

  if (profile.mediaDevices && profile.mediaDevices.enabled) {
    try {
      const mediaDevices = navigator.mediaDevices || {};
      if (!mediaDevices.__sbrMediaDevicesHardening) {
        Object.defineProperty(mediaDevices, '__sbrMediaDevicesHardening', { value: true });
        const originalEnumerateDevices = typeof mediaDevices.enumerateDevices === 'function'
          ? mediaDevices.enumerateDevices.bind(mediaDevices)
          : null;
        Object.defineProperty(mediaDevices, 'enumerateDevices', {
          configurable: true,
          enumerable: true,
          value: markNative(async function enumerateDevices() {
            const nativeDevices = originalEnumerateDevices ? await originalEnumerateDevices().catch(() => []) : [];
            if (!nativeDevices.length) return [];
            const profileDevices = profile.mediaDevices.devices || [];
            return nativeDevices.map((nativeDevice, index) => {
              const device = profileDevices[index % Math.max(1, profileDevices.length)] || {};
              return new Proxy(nativeDevice, {
                get(target, prop, receiver) {
                  if (prop === 'deviceId') return device.deviceId || Reflect.get(target, prop, receiver);
                  if (prop === 'groupId') return device.groupId || Reflect.get(target, prop, receiver);
                  if (prop === 'kind') return device.kind || Reflect.get(target, prop, receiver);
                  if (prop === 'label') return target.label || '';
                  const value = Reflect.get(target, prop, receiver);
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              });
            });
          }, 'enumerateDevices'),
        });
        if (!navigator.mediaDevices) defineGetter(Navigator.prototype || navigator, 'mediaDevices', mediaDevices);
      }
    } catch (_error) {}
  }

  if (profile.permissions && profile.permissions.enabled) {
    try {
      const permissions = navigator.permissions;
      if (permissions && !permissions.__sbrPermissionsHardening) {
        Object.defineProperty(permissions, '__sbrPermissionsHardening', { value: true });
        const originalQuery = typeof permissions.query === 'function' ? permissions.query.bind(permissions) : null;
        permissions.query = markNative(function query(descriptor) {
          const name = descriptor && descriptor.name ? String(descriptor.name) : '';
          const state = (profile.permissions.states || {})[name];
          if (!state || !originalQuery) {
            return originalQuery ? originalQuery(descriptor) : Promise.resolve({ state: 'prompt' });
          }
          return originalQuery(descriptor).then((status) => new Proxy(status, {
            get(target, prop, receiver) {
              if (prop === 'state') return state;
              return Reflect.get(target, prop, receiver);
            },
          })).catch(() => originalQuery(descriptor));
        }, 'query');
      }
    } catch (_error) {}
  }

  if (profile.screen && profile.screen.enabled) {
    try {
      const screenTarget = window.screen || {};
      for (const key of ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth']) {
        defineGetter(screenTarget, key, profile.screen[key]);
      }
    } catch (_error) {}
  }

  if (profile.webrtc && profile.webrtc.mode === 'disabled') {
    try {
      const createBlockedPeerConnection = () => markNative(function RTCPeerConnection() {
        throw new DOMException('RTCPeerConnection is disabled by browser privacy policy', 'NotAllowedError');
      }, 'RTCPeerConnection');
      window.RTCPeerConnection = createBlockedPeerConnection();
      if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = window.RTCPeerConnection;
    } catch (_error) {}
  } else if (profile.webrtc && profile.webrtc.enabled) {
    try {
      const NativePeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (NativePeerConnection && !NativePeerConnection.__sbrWebrtcHardening) {
        const WrappedPeerConnection = markNative(function RTCPeerConnection(config) {
          const safeConfig = config && typeof config === 'object' ? { ...config } : config;
          if (safeConfig && profile.webrtc.mode === 'proxy') {
            const iceServers = Array.isArray(safeConfig.iceServers) ? safeConfig.iceServers.filter(Boolean) : [];
            safeConfig.iceTransportPolicy = iceServers.length ? 'relay' : 'all';
          }
          const pc = new NativePeerConnection(safeConfig);
          const nativeAddEventListener = pc.addEventListener && pc.addEventListener.bind(pc);
          const nativeDispatchEvent = pc.dispatchEvent && pc.dispatchEvent.bind(pc);
          const wrapListener = (listener) => function wrappedIceCandidate(event) {
            const candidate = event && event.candidate && event.candidate.candidate;
            if (candidate && / typ host | typ srflx /i.test(candidate)) return undefined;
            return listener.call(this, event);
          };
          if (nativeAddEventListener) {
            pc.addEventListener = markNative(function addEventListener(type, listener, options) {
              if (type === 'icecandidate' && typeof listener === 'function') {
                return nativeAddEventListener(type, wrapListener(listener), options);
              }
              return nativeAddEventListener(type, listener, options);
            }, 'addEventListener');
          }
          try {
            Object.defineProperty(pc, 'onicecandidate', {
              configurable: true,
              enumerable: true,
              get() { return this.__sbrOnIceCandidate || null; },
              set(listener) {
                this.__sbrOnIceCandidate = listener;
                if (nativeAddEventListener && typeof listener === 'function') {
                  nativeAddEventListener('icecandidate', wrapListener(listener));
                }
              },
            });
          } catch (_onIceError) {}
          if (nativeDispatchEvent) {
            pc.dispatchEvent = markNative(function dispatchEvent(event) {
              const candidate = event && event.candidate && event.candidate.candidate;
              if (event && event.type === 'icecandidate' && candidate && / typ host | typ srflx /i.test(candidate)) return true;
              return nativeDispatchEvent(event);
            }, 'dispatchEvent');
          }
          return pc;
        }, 'RTCPeerConnection');
        WrappedPeerConnection.prototype = NativePeerConnection.prototype;
        Object.defineProperty(WrappedPeerConnection, '__sbrWebrtcHardening', { value: true });
        window.RTCPeerConnection = WrappedPeerConnection;
        if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = WrappedPeerConnection;
      }
    } catch (_error) {}
  }
})();`;
}

function buildCdpUserAgentOverride(fingerprint = {}) {
  const userAgent = String(fingerprint?.userAgent || '').trim();
  if (!userAgent) return null;
  const hardening = fingerprint?.hardening || {};
  const navigatorProfile = hardening.navigator || {};
  const userAgentMetadata = navigatorProfile.userAgentData || null;
  const payload = {
    userAgent,
    platform: String(navigatorProfile.platform || resolvePlatform(userAgent)),
  };
  const acceptLanguage = String(fingerprint?.acceptLanguage || '').trim();
  if (acceptLanguage) payload.acceptLanguage = acceptLanguage;
  if (userAgentMetadata) payload.userAgentMetadata = {
    brands: userAgentMetadata.brands || [],
    fullVersionList: userAgentMetadata.fullVersionList || [],
    fullVersion: userAgentMetadata.fullVersion || userAgentMetadata.uaFullVersion || '',
    platform: userAgentMetadata.platform || resolveUserAgentDataPlatform(payload.platform),
    platformVersion: userAgentMetadata.platformVersion || '',
    architecture: userAgentMetadata.architecture || '',
    model: userAgentMetadata.model || '',
    mobile: Boolean(userAgentMetadata.mobile),
    bitness: userAgentMetadata.bitness || '',
    wow64: Boolean(userAgentMetadata.wow64),
  };
  return payload;
}

function summarizeHardeningProfile(profile = {}) {
  return {
    enabled: Boolean(profile.enabled),
    seedHash: profile.seedHash || '',
    canvas: Boolean(profile.canvas?.enabled),
    webgl: profile.webgl?.enabled ? `${profile.webgl.vendor} / ${profile.webgl.renderer}` : 'off',
    audio: Boolean(profile.audio?.enabled),
    navigator: Boolean(profile.navigator?.enabled),
    screen: profile.screen?.enabled ? `${profile.screen.width}x${profile.screen.height}` : 'off',
    webrtc: profile.webrtc?.enabled ? profile.webrtc.mode : 'off',
    fonts: profile.fonts?.enabled ? profile.fonts.list : [],
    clientRects: Boolean(profile.clientRects?.enabled),
    mediaDevices: profile.mediaDevices?.enabled ? profile.mediaDevices.devices?.length || 0 : 0,
    permissions: Boolean(profile.permissions?.enabled),
    userAgentData: Boolean(profile.navigator?.userAgentData),
  };
}

async function applyFingerprintHardeningToContext(context, fingerprint = {}, options = {}) {
  const profile = fingerprint?.hardening || buildFingerprintHardeningProfile(fingerprint, options);
  if (!profile.enabled) {
    return { injected: false, profile, summary: summarizeHardeningProfile(profile), error: null };
  }
  if (!context || typeof context.addInitScript !== 'function') {
    return {
      injected: false,
      profile,
      summary: summarizeHardeningProfile(profile),
      error: 'CONTEXT_ADD_INIT_SCRIPT_UNAVAILABLE',
    };
  }
  const script = buildFingerprintHardeningInitScript(profile);
  await context.addInitScript(script);
  return { injected: true, profile, script, summary: summarizeHardeningProfile(profile), error: null };
}

module.exports = {
  DEFAULT_HARDENING_POLICY,
  buildFingerprintHardeningProfile,
  buildFingerprintHardeningInitScript,
  summarizeHardeningProfile,
  applyFingerprintHardeningToContext,
  buildCdpUserAgentOverride,
};
