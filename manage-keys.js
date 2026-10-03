const { createKey, listKeys, revokeKey } = require('./keystore');

const [, , cmd, ...args] = process.argv;

if (cmd === 'create') {
  const [name, dailyLimit] = args;
  if (!name) { console.error('usage: node manage-keys.js create <name> [dailyLimit=100]'); process.exit(1); }
  const key = createKey(name, dailyLimit ? Number(dailyLimit) : 100);
  console.log('Created key for "' + name + '":');
  console.log(key);
} else if (cmd === 'list') {
  const keys = listKeys();
  for (const [key, info] of Object.entries(keys)) {
    const today = new Date().toISOString().slice(0, 10);
    console.log(`${key}  name=${info.name}  dailyLimit=${info.dailyLimit}  usedToday=${info.usage[today] || 0}  created=${info.createdAt}`);
  }
  if (!Object.keys(keys).length) console.log('(no keys yet)');
} else if (cmd === 'revoke') {
  const [key] = args;
  if (!key) { console.error('usage: node manage-keys.js revoke <key>'); process.exit(1); }
  console.log(revokeKey(key) ? 'Revoked.' : 'Key not found.');
} else {
  console.log('usage: node manage-keys.js create <name> [dailyLimit] | list | revoke <key>');
}
