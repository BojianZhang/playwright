'use strict';

const fs = require('fs');
const path = require('path');

const PROFILE_PATHS = [
  'S0-proxy-precheck/profiles/dreamina-proxy-precheck-profile.json',
  'S1-entry/profiles/dreamina-entry-profile.json',
  'S2-credential/profiles/dreamina-credential-profile.json',
  'S3-verification/profiles/dreamina-verification-profile.json',
  'S4-profile-completion/profiles/dreamina-profile-completion-profile.json',
  'S5-post-auth-ready/profiles/dreamina-post-auth-ready-profile.json',
  'S6-account-delivery/profiles/dreamina-account-delivery-profile.json',
];

const baseDir = path.resolve(__dirname, '..');
let failed = false;

for (const relativePath of PROFILE_PATHS) {
  const filePath = path.join(baseDir, relativePath);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('profile root must be an object');
    }
    console.log(`[ok] ${relativePath}`);
  } catch (error) {
    failed = true;
    console.error(`[error] ${relativePath}: ${error.message}`);
  }
}

if (failed) process.exitCode = 1;
