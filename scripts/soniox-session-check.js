const fs = require('fs');
const path = require('path');
const { sendSonioxPcm, startSoniox, stopSoniox } = require('../dist-electron/asr/soniox-session.js');

function loadKey() {
  const raw = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').replace(/^\uFEFF/, '');
  const match = raw.match(/^SONIOX_API_KEY\s*=\s*(.*)$/m);
  if (!match) {
    throw new Error('missing-key');
  }
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (!value.trim()) {
    throw new Error('missing-key');
  }
  return value.trim();
}

async function check(source) {
  let error = null;
  let live = 0;
  let commits = 0;
  const started = await startSoniox(loadKey(), [source], {
    onLive: (_source, text) => {
      if (text) {
        live += 1;
      }
    },
    onCommit: () => {
      commits += 1;
    },
    onError: (_source, message) => {
      error = message;
    },
    onDiag: (line) => {
      console.log(line);
    },
  });
  sendSonioxPcm(source, new Float32Array(16000));
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await stopSoniox();
  console.log(
    JSON.stringify({
      source,
      startError: started.error,
      socketError: error,
      liveUpdates: live,
      commits,
    }),
  );
}

async function checkBoth() {
  const errors = [];
  const started = await startSoniox(loadKey(), ['you', 'system'], {
    onLive: () => {},
    onCommit: () => {},
    onError: (source, message) => {
      errors.push(`${source}: ${message}`);
    },
    onDiag: (line) => console.log(line),
  });
  sendSonioxPcm('you', new Float32Array(8000));
  sendSonioxPcm('system', new Float32Array(8000));
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await stopSoniox();
  console.log(JSON.stringify({ sources: ['you', 'system'], startError: started.error, errors }));
}

const mode = process.argv[2] || 'separate';
const run =
  mode === 'both'
    ? checkBoth()
    : check('you').then(() => check('system'));
run.catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
