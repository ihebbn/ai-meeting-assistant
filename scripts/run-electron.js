// Launches Electron with a clean environment.
// Some hosts (e.g. VS Code terminals) export ELECTRON_RUN_AS_NODE=1, which makes
// Electron behave as plain Node and crash on startup ("app is undefined").
const { spawn } = require('node:child_process');

const electronBinary = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
