// Launches Electron with a clean environment.
// Some hosts (e.g. VS Code terminals) export ELECTRON_RUN_AS_NODE=1, which makes
// Electron behave as plain Node and crash on startup ("app is undefined").
//
// Usage: node scripts/run-electron.js [entry.js] [args...]
// With no entry script, the app in the current directory ("." ) is started.
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const electronBinary = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const entry = args[0] && args[0].endsWith('.js') && fs.existsSync(args[0]) ? args.shift() : '.';

const child = spawn(electronBinary, [entry, ...args], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
