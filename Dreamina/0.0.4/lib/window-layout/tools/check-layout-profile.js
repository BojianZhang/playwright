'use strict';

const path = require('path');
const { readLayoutProfile } = require('../profile-loader');

const profilePath = path.resolve(__dirname, '..', 'window-layout-profile.json');
const profile = readLayoutProfile(profilePath);

if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
  console.error(`[error] invalid layout profile: ${profilePath}`);
  process.exitCode = 1;
} else {
  console.log(`[ok] ${profilePath}`);
}
