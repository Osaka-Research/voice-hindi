const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const KEYS_FILE = path.join(DATA_DIR, 'api_keys.json');

function load() {
  if (!fs.existsSync(KEYS_FILE)) return {};
  return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
}

function save(keys) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
}

function createKey(name, dailyLimit = 100) {
  const keys = load();
  const apiKey = 'vb_' + crypto.randomBytes(24).toString('hex');
  keys[apiKey] = {
    name,
    dailyLimit,
    createdAt: new Date().toISOString(),
    usage: {} // { 'YYYY-MM-DD': count }
  };
  save(keys);
  return apiKey;
}

function checkAndConsume(apiKey) {
  const keys = load();
  const entry = keys[apiKey];
  if (!entry) return { ok: false, reason: 'invalid_key' };
  const today = new Date().toISOString().slice(0, 10);
  const usedToday = entry.usage[today] || 0;
  if (usedToday >= entry.dailyLimit) return { ok: false, reason: 'limit_exceeded', entry };
  entry.usage[today] = usedToday + 1;
  save(keys);
  return { ok: true, entry };
}

function listKeys() {
  return load();
}

function revokeKey(apiKey) {
  const keys = load();
  if (!keys[apiKey]) return false;
  delete keys[apiKey];
  save(keys);
  return true;
}

module.exports = { createKey, checkAndConsume, listKeys, revokeKey };
