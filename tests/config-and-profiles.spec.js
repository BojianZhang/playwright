const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

const { getFirstmailApiConfig } = require('../shared-utils/firstmail-api');
const { readLayoutProfile } = require('../shared-window-layout/profile-loader');

test('Firstmail config resolver supports nested and legacy keys', () => {
  expect(getFirstmailApiConfig({
    firstmail: {
      apiKey: 'nested-key',
      apiBaseUrl: 'https://firstmail.example/',
    },
  })).toEqual({
    apiKey: 'nested-key',
    baseUrl: 'https://firstmail.example',
  });

  expect(getFirstmailApiConfig({
    firstmailApiKey: 'legacy-key',
    firstmailApiBaseUrl: 'https://legacy.example/',
  })).toEqual({
    apiKey: 'legacy-key',
    baseUrl: 'https://legacy.example',
  });
});

test('Dreamina profiles are valid JSON objects', () => {
  const profilePaths = [
    'Dreamina/0.0.3/S0-proxy-precheck/profiles/dreamina-proxy-precheck-profile.json',
    'Dreamina/0.0.3/S1-entry/profiles/dreamina-entry-profile.json',
    'Dreamina/0.0.3/S2-credential/profiles/dreamina-credential-profile.json',
    'Dreamina/0.0.3/S3-verification/profiles/dreamina-verification-profile.json',
    'Dreamina/0.0.3/S4-profile-completion/profiles/dreamina-profile-completion-profile.json',
    'Dreamina/0.0.3/S5-post-auth-ready/profiles/dreamina-post-auth-ready-profile.json',
    'Dreamina/0.0.3/S6-account-delivery/profiles/dreamina-account-delivery-profile.json',
  ];

  for (const relativePath of profilePaths) {
    const raw = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed, relativePath).toBeTruthy();
    expect(Array.isArray(parsed), relativePath).toBe(false);
    expect(typeof parsed, relativePath).toBe('object');
  }
});

test('window layout profile can be loaded', () => {
  const profilePath = path.join(repoRoot, 'shared-window-layout/window-layout-profile.json');
  const profile = readLayoutProfile(profilePath);
  expect(profile).toBeTruthy();
  expect(Array.isArray(profile)).toBe(false);
  expect(typeof profile).toBe('object');
});
