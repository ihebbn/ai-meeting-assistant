import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AiConfigError, ProviderHttpError } from '../types';
import { json, sseHeaders, startMockServer } from './mock-server.test-helper';
import { OpenAiCompatibleProvider } from './openai-compatible';

const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const baseParams = {
  question: 'What did they ask?',
  transcript: [{ speaker: 'System audio', text: 'Can you share your screen?' }],
  model: 'some-model',
  effort: 'medium' as const,
  apiKey: 'sk-test' as string | null,
};

describe('OpenAiCompatibleProvider.ask', () => {
  it('sends a minimal streaming request and streams deltas', async () => {
    const server = await startMockServer((_req, res) => {
      sseHeaders(res);
      res.write(chunk({ role: 'assistant', content: '' }));
      res.write(chunk({ content: 'Share ' }));
      res.write(chunk({ content: 'it.' }));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
    });
    try {
      const deltas: string[] = [];
      const result = await new OpenAiCompatibleProvider().ask({
        ...baseParams,
        baseUrl: `${server.baseUrl}/v1/`,
        onDelta: (t) => deltas.push(t),
      });
      assert.deepEqual(result, { status: 'done', text: 'Share it.' });
      assert.deepEqual(deltas, ['Share ', 'it.']);

      const req = server.requests[0]!;
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers['authorization'], 'Bearer sk-test');
      const body = JSON.parse(req.body);
      assert.deepEqual(Object.keys(body).sort(), ['messages', 'model', 'stream']);
      assert.equal(body.model, 'some-model');
      assert.equal(body.stream, true);
      assert.equal(body.messages[0].role, 'system');
      assert.match(body.messages[0].content, /untrusted data/);
      assert.equal(body.messages[1].role, 'user');
      assert.ok(body.messages[1].content.includes('System audio: Can you share your screen?'));
    } finally {
      await server.close();
    }
  });

  it('uses the system and content overrides when given (suggestions)', async () => {
    const server = await startMockServer((_req, res) => {
      sseHeaders(res);
      res.end('data: [DONE]\n\n');
    });
    try {
      await new OpenAiCompatibleProvider().ask({
        ...baseParams,
        baseUrl: server.baseUrl,
        system: 'CUSTOM SYSTEM',
        content: 'CUSTOM CONTENT',
        onDelta: () => undefined,
      });
      const body = JSON.parse(server.requests[0]!.body);
      assert.deepEqual(body.messages, [
        { role: 'system', content: 'CUSTOM SYSTEM' },
        { role: 'user', content: 'CUSTOM CONTENT' },
      ]);
    } finally {
      await server.close();
    }
  });

  it('reassembles events split across arbitrary network writes', async () => {
    const payload = chunk({ content: 'Hello ' }) + chunk({ content: 'wörld' }) + chunk({}, 'stop') + 'data: [DONE]\n\n';
    const server = await startMockServer((_req, res) => {
      sseHeaders(res);
      for (let i = 0; i < payload.length; i += 7) {
        res.write(payload.slice(i, i + 7));
      }
      res.end();
    });
    try {
      const result = await new OpenAiCompatibleProvider().ask({
        ...baseParams,
        baseUrl: server.baseUrl,
        onDelta: () => undefined,
      });
      assert.deepEqual(result, { status: 'done', text: 'Hello wörld' });
    } finally {
      await server.close();
    }
  });

  it('treats the stream closing without [DONE] as the end (e.g. Together)', async () => {
    const server = await startMockServer((_req, res) => {
      sseHeaders(res);
      res.write(chunk({ content: 'ok' }));
      res.end(chunk({}, 'stop'));
    });
    try {
      const result = await new OpenAiCompatibleProvider().ask({ ...baseParams, baseUrl: server.baseUrl, onDelta: () => undefined });
      assert.deepEqual(result, { status: 'done', text: 'ok' });
    } finally {
      await server.close();
    }
  });

  it('omits the Authorization header when there is no key', async () => {
    const server = await startMockServer((_req, res) => {
      sseHeaders(res);
      res.end('data: [DONE]\n\n');
    });
    try {
      await new OpenAiCompatibleProvider().ask({ ...baseParams, apiKey: null, baseUrl: server.baseUrl, onDelta: () => undefined });
      assert.equal('authorization' in server.requests[0]!.headers, false);
    } finally {
      await server.close();
    }
  });

  it('maps finish_reason length, content_filter and delta.refusal', async () => {
    const run = async (writeBody: (res: import('node:http').ServerResponse) => void) => {
      const server = await startMockServer((_req, res) => {
        sseHeaders(res);
        writeBody(res);
        res.end('data: [DONE]\n\n');
      });
      try {
        return await new OpenAiCompatibleProvider().ask({ ...baseParams, baseUrl: server.baseUrl, onDelta: () => undefined });
      } finally {
        await server.close();
      }
    };
    assert.deepEqual(
      await run((res) => {
        res.write(chunk({ content: 'cut' }));
        res.write(chunk({}, 'length'));
      }),
      { status: 'truncated', text: 'cut' },
    );
    assert.deepEqual(
      await run((res) => {
        res.write(chunk({}, 'content_filter'));
      }),
      { status: 'refused', text: '', category: 'content_filter', explanation: null },
    );
    assert.deepEqual(
      await run((res) => {
        res.write(chunk({ refusal: 'I cannot ' }));
        res.write(chunk({ refusal: 'help.' }, 'stop'));
      }),
      { status: 'refused', text: '', category: null, explanation: 'I cannot help.' },
    );
  });

  it('throws a ProviderHttpError with the status and message on HTTP errors', async () => {
    const server = await startMockServer((_req, res) =>
      json(res, 429, { error: { message: 'You exceeded your quota for sk-test' } }),
    );
    try {
      await assert.rejects(
        new OpenAiCompatibleProvider().ask({ ...baseParams, baseUrl: server.baseUrl, onDelta: () => undefined }),
        (err: unknown) =>
          err instanceof ProviderHttpError &&
          err.status === 429 &&
          /exceeded your quota/.test(err.message) &&
          !err.message.includes('sk-test'),
      );
    } finally {
      await server.close();
    }
  });

  it('throws on an error object delivered inside the stream', async () => {
    const server = await startMockServer((_req, res) => {
      sseHeaders(res);
      res.write(chunk({ content: 'partial' }));
      res.end(`data: ${JSON.stringify({ error: { message: 'overloaded' } })}\n\n`);
    });
    try {
      await assert.rejects(
        new OpenAiCompatibleProvider().ask({ ...baseParams, baseUrl: server.baseUrl, onDelta: () => undefined }),
        /overloaded/,
      );
    } finally {
      await server.close();
    }
  });

  it('cancels when the signal aborts mid-stream and keeps the partial text', async () => {
    const server = await startMockServer((_req, res) => {
      sseHeaders(res);
      res.write(chunk({ content: 'partial' })); // then hang
    });
    try {
      const controller = new AbortController();
      const result = await new OpenAiCompatibleProvider().ask({
        ...baseParams,
        baseUrl: server.baseUrl,
        signal: controller.signal,
        onDelta: () => controller.abort(),
      });
      assert.deepEqual(result, { status: 'cancelled', text: 'partial' });
    } finally {
      await server.close();
    }
  });

  it('raises a config error for a missing model or base URL before any request', async () => {
    const provider = new OpenAiCompatibleProvider();
    await assert.rejects(provider.ask({ ...baseParams, model: '', baseUrl: 'https://x.test', onDelta: () => undefined }), AiConfigError);
    await assert.rejects(provider.ask({ ...baseParams, baseUrl: null, onDelta: () => undefined }), AiConfigError);
  });
});

describe('OpenAiCompatibleProvider.listModels', () => {
  it('lists ids newest first, de-duplicates, and prefers a provider display name', async () => {
    const server = await startMockServer((_req, res) =>
      json(res, 200, {
        object: 'list',
        data: [
          { id: 'old', object: 'model', created: 100 },
          { id: 'new', object: 'model', created: 300 },
          { id: 'new', object: 'model', created: 300 },
          { id: 'router/model', name: 'Pretty Name', created: 200 },
          { object: 'model' },
          { id: 'no-created-b' },
          { id: 'no-created-a' },
        ],
      }),
    );
    try {
      const models = await new OpenAiCompatibleProvider().listModels({
        apiKey: 'sk-test',
        baseUrl: `${server.baseUrl}/v1/`,
      });
      assert.deepEqual(models, [
        { id: 'new', displayName: 'new' },
        { id: 'router/model', displayName: 'Pretty Name' },
        { id: 'old', displayName: 'old' },
        { id: 'no-created-a', displayName: 'no-created-a' },
        { id: 'no-created-b', displayName: 'no-created-b' },
      ]);
      assert.equal(server.requests[0]!.url, '/v1/models');
      assert.equal(server.requests[0]!.headers['authorization'], 'Bearer sk-test');
    } finally {
      await server.close();
    }
  });

  it('tolerates an unexpected body and reports HTTP errors', async () => {
    const ok = await startMockServer((_req, res) => json(res, 200, { nope: true }));
    const bad = await startMockServer((_req, res) => json(res, 401, { error: { message: 'bad key' } }));
    try {
      const provider = new OpenAiCompatibleProvider();
      assert.deepEqual(await provider.listModels({ apiKey: 'k', baseUrl: ok.baseUrl }), []);
      await assert.rejects(
        provider.listModels({ apiKey: 'k', baseUrl: bad.baseUrl }),
        (err: unknown) => err instanceof ProviderHttpError && err.status === 401,
      );
    } finally {
      await ok.close();
      await bad.close();
    }
  });
});
