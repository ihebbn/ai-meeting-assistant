/**
 * Opens the documented Soniox realtime socket.
 * Prints timings and recognized text for a local synthetic clip only.
 * Never prints the API key.
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const {
  SONIOX_SAMPLE_RATE,
  SONIOX_WS_URL,
  applySonioxTokens,
  buildSonioxStartMessage,
  emptyCaption,
  floatToPcm16le,
  takeCommittedPhrase,
} = require('../dist-electron/asr/soniox-tokens.js');

function loadKey() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error('missing-env-file');
  }
  const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(/^SONIOX_API_KEY\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.trim();
    if (value) {
      return value;
    }
  }
  throw new Error('missing-key');
}

function parseWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('not a wav');
  }
  let offset = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!data || bits !== 16 || !rate || !channels) {
    throw new Error(`unsupported wav rate=${rate} ch=${channels} bits=${bits}`);
  }
  const samples = new Float32Array(data.length / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = data.readInt16LE(i * 2) / 32768;
  }
  if (channels === 1 && rate === SONIOX_SAMPLE_RATE) {
    return samples;
  }
  const mono = new Float32Array(Math.floor(samples.length / channels));
  for (let i = 0; i < mono.length; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) {
      sum += samples[i * channels + c] || 0;
    }
    mono[i] = sum / channels;
  }
  const outLen = Math.floor((mono.length * SONIOX_SAMPLE_RATE) / rate);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const src = (i * rate) / SONIOX_SAMPLE_RATE;
    const index = Math.floor(src);
    const frac = src - index;
    const a = mono[index] || 0;
    const b = mono[Math.min(index + 1, mono.length - 1)] || 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function openSocket(label, pcm) {
  const key = loadKey();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SONIOX_WS_URL, {
      headers: { Authorization: `Bearer ${key}` },
    });
    let state = emptyCaption();
    let committed = '';
    let firstAudioAt = 0;
    let firstPartialMs = null;
    let error = null;
    const finish = (extra) => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      resolve({
        label,
        committed: committed.trim(),
        live: `${state.finalText}${state.provisional}`.trim(),
        firstPartialMs,
        error,
        ...extra,
      });
    };
    const timer = setTimeout(() => finish({ timedOut: true }), 25000);
    ws.on('open', () => {
      ws.send(JSON.stringify(buildSonioxStartMessage()));
      const frame = 1280;
      let offset = 0;
      const sendNext = () => {
        if (ws.readyState !== WebSocket.OPEN) {
          return;
        }
        if (offset >= pcm.length) {
          ws.send(JSON.stringify({ type: 'finalize' }));
          ws.send('');
          return;
        }
        if (!firstAudioAt) {
          firstAudioAt = Date.now();
        }
        const slice = pcm.subarray(offset, Math.min(offset + frame, pcm.length));
        ws.send(floatToPcm16le(slice));
        offset += frame;
        setTimeout(sendNext, 80);
      };
      sendNext();
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        return;
      }
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        error = 'non-json response';
        return;
      }
      if (message.error_code) {
        error = `${message.error_type || 'error'} ${message.error_code}: ${message.error_message || ''}`.trim();
        clearTimeout(timer);
        finish({ timedOut: false });
        return;
      }
      const tokens = Array.isArray(message.tokens) ? message.tokens : [];
      const hadPartial = tokens.some((token) => token.is_final === false && token.text);
      state = applySonioxTokens(state, tokens);
      if (hadPartial && firstPartialMs == null && firstAudioAt) {
        firstPartialMs = Date.now() - firstAudioAt;
      }
      const phrase = takeCommittedPhrase(state);
      if (phrase) {
        committed = `${committed} ${phrase.text}`.trim();
        state = phrase.next;
      }
      if (message.finished) {
        const tail = `${state.finalText}${state.provisional}`.trim();
        if (tail) {
          committed = `${committed} ${tail}`.trim();
        }
        clearTimeout(timer);
        finish({ timedOut: false });
      }
    });
    ws.on('error', (err) => {
      error = err instanceof Error ? err.message : String(err);
      clearTimeout(timer);
      finish({ timedOut: false });
    });
    ws.on('close', () => {
      clearTimeout(timer);
      finish({ timedOut: false });
    });
  });
}

async function main() {
  const wav = process.argv[2];
  const pcm = wav ? parseWav(wav) : new Float32Array(SONIOX_SAMPLE_RATE);
  const kind = wav ? `wav ${pcm.length} samples` : '1s silence';
  console.log(`mic-format socket (${kind})`);
  const mic = await openSocket('mic', pcm);
  console.log(JSON.stringify(mic));
  console.log(`system-format socket (${kind})`);
  const system = await openSocket('system', pcm);
  console.log(JSON.stringify(system));
  console.log('both sockets, 0.4s silence');
  const silence = new Float32Array(Math.floor(SONIOX_SAMPLE_RATE * 0.4));
  const both = await Promise.all([openSocket('mic-combined', silence), openSocket('system-combined', silence)]);
  console.log(JSON.stringify(both));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'missing-env-file' || message === 'missing-key') {
    console.error('SONIOX_API_KEY is not in .env');
    process.exit(2);
  }
  console.error(message);
  process.exit(1);
});
