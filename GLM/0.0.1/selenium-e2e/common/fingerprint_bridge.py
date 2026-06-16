#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared browser-runtime fingerprint bridge for Selenium/CDP."""

import json
import os
import subprocess
from pathlib import Path

from .base import log


def _repo_root():
    return Path(__file__).resolve().parents[4]


def _json_for_node(value):
    return json.dumps(value, ensure_ascii=False)


def _node_script(seed, runtime_overrides=None):
    root = str(_repo_root()).replace("\\", "\\\\")
    payload = {
        "seed": seed or "selenium",
        "runtime": runtime_overrides or {},
    }
    return """
const runtime = require('%s/shared-browser-runtime');
const input = %s;
const fingerprint = runtime.createRandomFingerprint({
  ...(input.runtime || {}),
  browserIdentity: {
    enabled: false,
    includeAcceptLanguageHeader: false,
    clearStorageOnStart: false
  }
}, { hardeningSeed: input.seed || 'selenium' });
const script = runtime.buildFingerprintHardeningInitScript(fingerprint.hardening);
process.stdout.write(JSON.stringify({
  script,
  cdpUserAgentOverride: runtime.buildCdpUserAgentOverride(fingerprint),
  summary: fingerprint.summary,
  hardening: runtime.summarizeHardeningProfile(fingerprint.hardening)
}));
""" % (root, _json_for_node(payload))


def _adspower_node_script(proxy=None, seed="", screen_resolution=""):
    root = str(_repo_root()).replace("\\", "\\\\")
    payload = {
        "proxy": proxy or None,
        "seed": seed or "",
        "adspower": {
            "screenResolution": screen_resolution or "",
        },
    }
    return """
const runtime = require('%s/shared-browser-runtime');
const input = %s;
const payload = runtime.buildAdsPowerFingerprintPayload({}, {
  proxy: input.proxy,
  seed: input.seed,
  adspower: input.adspower,
});
process.stdout.write(JSON.stringify({
  config: payload.config,
  summary: payload.summary,
  hardening: payload.hardening
}));
""" % (root, _json_for_node(payload))


def _run_node(script, timeout=10):
    return subprocess.run(
        ["node", "-e", script],
        cwd=str(_repo_root()),
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def build_shared_fingerprint_payload(seed="", runtime_overrides=None):
    if os.environ.get("SHARED_FINGERPRINT", "1").strip().lower() in ("0", "false", "off", "no"):
        return {"script": "", "hardening": {}, "cdpUserAgentOverride": None}
    try:
        result = _run_node(_node_script(seed, runtime_overrides), timeout=10)
        if result.returncode != 0:
            log("[fingerprint] shared runtime script build failed: %s" % (result.stderr or "")[:120])
            return {"script": "", "hardening": {}, "cdpUserAgentOverride": None}
        payload = json.loads(result.stdout or "{}")
        return {
            "script": payload.get("script", ""),
            "hardening": payload.get("hardening", {}),
            "cdpUserAgentOverride": payload.get("cdpUserAgentOverride") or None,
        }
    except Exception as exc:
        log("[fingerprint] shared runtime bridge unavailable: %s" % str(exc)[:120])
        return {"script": "", "hardening": {}, "cdpUserAgentOverride": None}


def build_shared_fingerprint_script(seed="", runtime_overrides=None):
    payload = build_shared_fingerprint_payload(seed, runtime_overrides)
    return payload.get("script", ""), payload.get("hardening", {})


def _read_current_browser_runtime(driver):
    try:
        data = driver.execute_script("""
return {
  userAgent: navigator.userAgent || '',
  acceptLanguage: (navigator.languages || []).join(',') || navigator.language || '',
  locale: navigator.language || '',
  platform: navigator.platform || '',
  screenWidth: screen && screen.width,
  screenHeight: screen && screen.height,
  screenAvailWidth: screen && screen.availWidth,
  screenAvailHeight: screen && screen.availHeight,
  deviceScaleFactor: window.devicePixelRatio || 1
};
""")
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _apply_cdp_user_agent_override(driver, override):
    if not override:
        return False
    try:
        driver.execute_cdp_cmd("Network.enable", {})
        driver.execute_cdp_cmd("Network.setUserAgentOverride", override)
        return True
    except Exception as exc:
        log("[fingerprint] shared runtime UA override failed: %s" % str(exc)[:120])
        return False


def inject_shared_fingerprint(driver, seed="", runtime_overrides=None):
    runtime = dict(runtime_overrides or {})
    current = _read_current_browser_runtime(driver)
    for key, value in current.items():
        if value not in (None, "") and key not in runtime:
            runtime[key] = value
    if "userAgent" not in runtime:
        runtime["userAgent"] = None
    payload = build_shared_fingerprint_payload(seed, runtime)
    source = payload.get("script", "")
    summary = payload.get("hardening", {})
    cdp_override = payload.get("cdpUserAgentOverride")
    if not source:
        return False
    try:
        _apply_cdp_user_agent_override(driver, cdp_override)
        driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": source})
        try:
            driver.execute_cdp_cmd("Runtime.evaluate", {"expression": source})
        except Exception as exc:
            log("[fingerprint] shared runtime current page apply failed: %s" % str(exc)[:120])
        log("[fingerprint] shared runtime hardening injected seed=%s" % (summary.get("seedHash") or ""))
        return True
    except Exception as exc:
        log("[fingerprint] shared runtime hardening inject failed: %s" % str(exc)[:120])
        return False


def build_adspower_fingerprint_config(proxy=None, seed="", screen_resolution=""):
    if os.environ.get("SHARED_ADSPOWER_FINGERPRINT", "1").strip().lower() in ("0", "false", "off", "no"):
        return None, {}
    try:
        result = _run_node(_adspower_node_script(proxy, seed, screen_resolution), timeout=10)
        if result.returncode != 0:
            log("[fingerprint] shared AdsPower config build failed: %s" % (result.stderr or "")[:120])
            return None, {}
        payload = json.loads(result.stdout or "{}")
        config = payload.get("config") or None
        summary = payload.get("summary") or {}
        if config:
            log("[fingerprint] shared AdsPower config seed=%s ua=%s" % (
                summary.get("hardeningSeedHash") or "",
                (config.get("ua") or "")[:36],
            ))
        return config, summary
    except Exception as exc:
        log("[fingerprint] shared AdsPower bridge unavailable: %s" % str(exc)[:120])
        return None, {}


__all__ = [
    "build_adspower_fingerprint_config",
    "build_shared_fingerprint_payload",
    "build_shared_fingerprint_script",
    "inject_shared_fingerprint",
]
