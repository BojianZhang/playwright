'use strict';
// ⟦共享规范实现 · 改这里;各项目 billing/address-gen.js 是 re-export shim,勿改⟧ 边界/准入/清单见 shared-billing/README.md

// ═══════════════════════════════════════════════════════════════════════
// billing — address-gen（随机美国账单地址生成器 · 规范实现）
//
// 历史出处：Openrouter/0.0.1/billing/address-gen.js(现已收口到 shared-billing)
//
// 用途：充值时需要美国账单地址。默认从「免税州」(无州销售税)随机生成一条
//       看起来真实的地址(真实城市 + 真实邮编前缀 + 随机街道/姓名)，对标
//       usaddressgen.com 的免税州地址，省去手工粘贴。
//
// 免税州(无 state sales tax)：Oregon / Delaware / Montana / New Hampshire。
//   截图里你用的就是 Oregon(97209) 和卡邮编 Delaware(19711)。
// ═══════════════════════════════════════════════════════════════════════

// 每个州：全称 + 一组「真实城市, 真实邮编」对(邮编与城市匹配，提高通过率)。
const STATE_DATA = {
  Oregon: {
    abbr: 'OR',
    cities: [
      ['Portland', '97209'], ['Portland', '97201'], ['Portland', '97214'], ['Portland', '97232'],
      ['Salem', '97301'], ['Eugene', '97401'], ['Bend', '97701'], ['Hillsboro', '97124'],
      ['Beaverton', '97005'], ['Gresham', '97030'], ['Medford', '97501'], ['Corvallis', '97330'],
    ],
  },
  Delaware: {
    abbr: 'DE',
    cities: [
      ['Wilmington', '19801'], ['Wilmington', '19805'], ['Wilmington', '19806'],
      ['Newark', '19711'], ['Newark', '19713'], ['Dover', '19901'], ['Dover', '19904'],
      ['Bear', '19701'], ['Middletown', '19709'], ['Smyrna', '19977'],
    ],
  },
  Montana: {
    abbr: 'MT',
    cities: [
      ['Billings', '59101'], ['Billings', '59102'], ['Missoula', '59801'], ['Missoula', '59802'],
      ['Bozeman', '59715'], ['Great Falls', '59401'], ['Helena', '59601'], ['Butte', '59701'],
      ['Kalispell', '59901'],
    ],
  },
  'New Hampshire': {
    abbr: 'NH',
    cities: [
      ['Manchester', '03101'], ['Manchester', '03103'], ['Nashua', '03060'], ['Nashua', '03063'],
      ['Concord', '03301'], ['Derry', '03038'], ['Dover', '03820'], ['Rochester', '03867'],
      ['Salem', '03079'],
    ],
  },
};

const TAX_FREE_STATES = Object.keys(STATE_DATA);

const FIRST_NAMES = ['James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'William', 'Elizabeth', 'David', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica', 'Thomas', 'Sarah', 'Charles', 'Karen', 'Christopher', 'Nancy', 'Daniel', 'Lisa', 'Matthew', 'Betty', 'Anthony', 'Margaret', 'Mark', 'Sandra', 'Andrew', 'Ashley', 'Kenneth', 'Emily', 'Kevin', 'Donna', 'Brian', 'Michelle', 'George', 'Carol', 'Edward', 'Amanda', 'Ronald', 'Dorothy', 'Timothy', 'Melissa', 'Jason', 'Deborah'];
const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores', 'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera', 'Campbell', 'Mitchell'];
const STREET_DIRS = ['', '', '', 'N', 'S', 'E', 'W', 'Northwest', 'Northeast', 'Southwest'];
const STREET_NAMES = ['Main', 'Oak', 'Pine', 'Maple', 'Cedar', 'Elm', 'Washington', 'Lake', 'Hill', 'Park', 'Walnut', 'Spring', 'Sunset', 'River', 'Highland', 'Forest', 'Jefferson', 'Madison', 'Lincoln', 'Franklin', 'Adams', 'Jackson', 'Church', 'Center', 'Ridge', 'Meadow', 'Willow', 'Birch', 'Chestnut', 'Cypress'];
const STREET_NUM_NAMES = ['1st', '2nd', '3rd', '4th', '5th', '7th', '8th', '9th', '10th', '11th', '12th', '14th'];
const STREET_SUFFIX = ['Ave', 'St', 'Rd', 'Dr', 'Ln', 'Blvd', 'Way', 'Ct', 'Pl', 'Ter'];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * 把外部传入的州名/缩写规范化为内部全称(支持 "OR"/"oregon"/"New Hampshire" 等)。
 */
function normalizeStates(states) {
  const list = Array.isArray(states)
    ? states
    : String(states || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const s of list) {
    const low = s.toLowerCase();
    const full = TAX_FREE_STATES.find((f) => f.toLowerCase() === low || STATE_DATA[f].abbr.toLowerCase() === low);
    if (full && !out.includes(full)) out.push(full);
  }
  return out.length ? out : TAX_FREE_STATES.slice();
}

/**
 * 随机生成一条美国账单地址。
 * @param {object} [opts]
 * @param {string[]|string} [opts.states] 限定州(全称或缩写)；缺省=全部免税州
 * @returns {{name,line1,line2,city,state,zip,country}}
 */
function generateAddress(opts = {}) {
  const states = normalizeStates(opts.states);
  const state = pick(states);
  const data = STATE_DATA[state];
  const [city, zip] = pick(data.cities);

  const dir = pick(STREET_DIRS);
  const useNumberedStreet = Math.random() < 0.35;
  const streetName = useNumberedStreet ? pick(STREET_NUM_NAMES) : pick(STREET_NAMES);
  const line1 = [randInt(100, 9899), dir, streetName, pick(STREET_SUFFIX)].filter(Boolean).join(' ');

  const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
  return { name, line1, line2: '', city, state, zip, country: 'United States' };
}

module.exports = {
  generateAddress,
  normalizeStates,
  TAX_FREE_STATES,
  STATE_DATA,
};
