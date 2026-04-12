const fs = require('fs');
const path = require('path');

const PROFILE_PATH = path.join(__dirname, 'window-layout-profile.json');

function ensureString(value, fieldName) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`WINDOW_LAYOUT_PROFILE_INVALID:${fieldName}:EMPTY`);
  return text;
}

function ensureNumber(value, fieldName, { min } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error(`WINDOW_LAYOUT_PROFILE_INVALID:${fieldName}:NOT_NUMBER`);
  if (typeof min === 'number' && num < min) throw new Error(`WINDOW_LAYOUT_PROFILE_INVALID:${fieldName}:LT_${min}`);
  return num;
}

function ensureObject(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`WINDOW_LAYOUT_PROFILE_INVALID:${fieldName}:NOT_OBJECT`);
  }
  return value;
}

function validateProfile(profile) {
  const root = ensureObject(profile, 'root');
  const preferredColumnsRaw = ensureObject(root.preferredColumns, 'preferredColumns');
  const preferredColumns = {};
  for (const [key, value] of Object.entries(preferredColumnsRaw)) {
    const normalizedKey = String(key).trim();
    if (!/^\d+$/.test(normalizedKey)) {
      throw new Error(`WINDOW_LAYOUT_PROFILE_INVALID:preferredColumns.${key}:BAD_KEY`);
    }
    preferredColumns[normalizedKey] = ensureNumber(value, `preferredColumns.${key}`, { min: 1 });
  }

  return {
    mode: ensureString(root.mode, 'mode'),
    margin: ensureNumber(root.margin, 'margin', { min: 0 }),
    gap: ensureNumber(root.gap, 'gap', { min: 0 }),
    topInset: ensureNumber(root.topInset, 'topInset', { min: 0 }),
    bottomInset: ensureNumber(root.bottomInset, 'bottomInset', { min: 0 }),
    singleMinWidth: ensureNumber(root.singleMinWidth, 'singleMinWidth', { min: 320 }),
    singleMinHeight: ensureNumber(root.singleMinHeight, 'singleMinHeight', { min: 240 }),
    minWindowWidth: ensureNumber(root.minWindowWidth, 'minWindowWidth', { min: 320 }),
    minWindowHeight: ensureNumber(root.minWindowHeight, 'minWindowHeight', { min: 240 }),
    preferredColumns,
  };
}

function summarizeProfile(profile) {
  return {
    mode: profile.mode,
    margin: profile.margin,
    gap: profile.gap,
    minWindowWidth: profile.minWindowWidth,
    minWindowHeight: profile.minWindowHeight,
    preferredColumnRules: Object.keys(profile.preferredColumns).length,
  };
}

function loadWindowLayoutProfile() {
  if (!fs.existsSync(PROFILE_PATH)) {
    throw new Error(`WINDOW_LAYOUT_PROFILE_MISSING:${PROFILE_PATH}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`WINDOW_LAYOUT_PROFILE_PARSE_FAILED:${error.message}`);
  }
  return validateProfile(parsed);
}

function runWindowLayoutProfileSelfCheck() {
  const profile = loadWindowLayoutProfile();
  const summary = summarizeProfile(profile);
  console.log('Window layout profile self-check: OK');
  console.log(`Profile path: ${PROFILE_PATH}`);
  console.log(`mode: ${summary.mode}`);
  console.log(`margin: ${summary.margin}`);
  console.log(`gap: ${summary.gap}`);
  console.log(`minWindowWidth: ${summary.minWindowWidth}`);
  console.log(`minWindowHeight: ${summary.minWindowHeight}`);
  console.log(`preferredColumnRules: ${summary.preferredColumnRules}`);
}

if (require.main === module) {
  try {
    runWindowLayoutProfileSelfCheck();
  } catch (error) {
    console.error('Window layout profile self-check: FAILED');
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  PROFILE_PATH,
  loadWindowLayoutProfile,
  validateProfile,
  summarizeProfile,
  runWindowLayoutProfileSelfCheck,
};
