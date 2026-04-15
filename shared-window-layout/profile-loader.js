'use strict';

const fs = require('fs');
const path = require('path');

function readLayoutProfile(profilePath) {
  try {
    if (!profilePath || !fs.existsSync(profilePath)) return null;
    return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function resolveLayoutProfilePath(profilePath = '') {
  return profilePath ? path.resolve(profilePath) : '';
}

module.exports = {
  readLayoutProfile,
  resolveLayoutProfilePath,
};
