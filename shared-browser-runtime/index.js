'use strict';

const { createRandomFingerprint, buildContextFingerprintOptions } = require('./fingerprint');
const { normalizeBlockedResourceTypes, applyResourcePolicy } = require('./resource-policy');
const { applyWindowLayoutToLaunchOptions } = require('./window-runtime');
const { buildLaunchOptions, createBrowserRuntime } = require('./create-browser-runtime');

module.exports = {
  createRandomFingerprint,
  buildContextFingerprintOptions,
  normalizeBlockedResourceTypes,
  applyResourcePolicy,
  applyWindowLayoutToLaunchOptions,
  buildLaunchOptions,
  createBrowserRuntime,
};
