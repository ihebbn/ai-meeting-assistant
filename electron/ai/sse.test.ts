import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { type SseMessage, readSse } from './sse';

const enc = new TextEncoder();

async function collect(chunks: string[]): Promise<SseMessage[]> {
  async function* body(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) {
      yield enc.encode(chunk);
    }
  }
  const out: SseMessage[] = [];
  for await (const message of readSse(body())) {
    out.push(message);
  }
  return out;
}

describe('readSse', () => {
  it('parses data events separated by blank lines', async () => {
    assert.deepEqual(await collect(['data: one\n\ndata: two\n\n']), [
      { event: null, data: 'one' },
      { event: null, data: 'two' },
    ]);
  });

  it('handles lines split across chunks, including inside multi-byte characters', async () => {
    const bytes = enc.encode('data: héllo wörld\n\n');
    async function* body(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < bytes.length; i += 3) {
        yield bytes.slice(i, i + 3);
      }
    }
    const out: SseMessage[] = [];
    for await (const m of readSse(body())) {
      out.push(m);
    }
    assert.deepEqual(out, [{ event: null, data: 'héllo wörld' }]);
  });

  it('supports CRLF, lone CR, and a CR/LF pair split between chunks', async () => {
    assert.deepEqual(await collect(['data: a\r\n\r\ndata: b\r\r']), [
      { event: null, data: 'a' },
      { event: null, data: 'b' },
    ]);
    assert.deepEqual(await collect(['data: c\r', '\n\r', '\n']), [{ event: null, data: 'c' }]);
  });

  it('joins multi-line data and reads event names', async () => {
    assert.deepEqual(await collect(['event: update\ndata: line1\ndata: line2\n\n']), [
      { event: 'update', data: 'line1\nline2' },
    ]);
  });

  it('ignores comments and unknown fields, and strips one leading space only', async () => {
    assert.deepEqual(await collect([': keep-alive\nid: 7\nretry: 1000\ndata:  spaced\n\n']), [
      { event: null, data: ' spaced' },
    ]);
  });

  it('flushes a final event that has no trailing blank line', async () => {
    assert.deepEqual(await collect(['data: last']), [{ event: null, data: 'last' }]);
  });

  it('yields nothing for an empty or comment-only stream', async () => {
    assert.deepEqual(await collect([]), []);
    assert.deepEqual(await collect([': ping\n\n']), []);
  });

  it('passes through the [DONE] sentinel as data', async () => {
    assert.deepEqual(await collect(['data: [DONE]\n\n']), [{ event: null, data: '[DONE]' }]);
  });
});
