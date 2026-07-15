const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const lockfiles = ['package-lock.json', 'yarn.lock'];

for (const file of lockfiles) {
  const target = path.join(cwd, file);
  try {
    fs.rmSync(target, { force: true });
  } catch (error) {
    console.warn(`Unable to remove ${file}:`, error.message);
  }
}

const userAgent = process.env.npm_config_user_agent || '';
if (!userAgent.startsWith('pnpm/')) {
  console.error('Use pnpm instead');
  process.exit(1);
}
