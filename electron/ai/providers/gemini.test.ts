import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AiConfigError, ProviderHttpError } from '../types';
import { GeminiProvider } from './gemini';
import { json, sseHeaders, startMockServer } from './mock-server.test-helper';

const event = (payload: object) => `data: ${JSON.stringify(payload)}\n\n`;
const part = (text: string, extra: object = {}) => ({ candidates: [{ content: { role: 'model', parts: [{ text, ...extra }] } }] });

const baseParams = {
  question: 'What did they ask?',
  transcript: [{ speaker: 'System audio', text: 'Can you share your screen?' }],
  model: 'gemini-test',
  effort: 'medium' as const,
  apiKey: 'AIza-test-key' as string | null,
};

describe('GeminiProvider.ask', () => {
  it('posts the documented request shape and streams text parts', async () => {
    const server = await startMockServer((_req, res) => {
      sseHeaders(res);
      res.write(event(part('Share ')));
      res.write(event(part('it.')));
      res.end(event({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }] }));
    });
    try {
      const deltas: string[] = [];
      const result = await new GeminiProvider().ask({
        ...baseParams,
        baseUrl: `${server.baseUrl}/v1beta`,
        onDelta: (t) => deltas.push(t),
      });
      assert.deepEqual(result, { status: 'done', text: 'Share it.' });
      assert.deepEqual(deltas, ['Share ', 'it.']);

      const req = server.requests[0]!;
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1beta/models/gemini-test:streamGenerateContent?alt=sse&key=AIza-test-key');
      const body = JSON.parse(req.body);
      assert.match(body.systemInstruction.parts[0].text, /untrusted data/);
      assert.equal(body.contents[0].role, 'user');
      assert.ok(body.contents[0].parts[0].text.includes('System audio: Can you share your screen?'));
    } finally {
      await server.close();
    }
  });

  it('uses the system and content overrides when given (suggestions)', async () => {
    const server = await startMockServer((_req, res) => {
      sseHeaders(res);
      res.end(event({ candidates: [{ finishReason: 'STOP' }] }));
    });
    try {
      await new GeminiProvider().ask({
        ...baseParams,
        baseUrl: server.baseUrl,
        system: 'CUSTOM SYSTEM',
        content: 'CUSTOM CONTENT',
        onDelta: () => undefined,
      });
      const body = JSON.parse(server.requests[0]!.body);
      assert.equal(body.systemInstruction.parts[0].text, 'CUSTOM SYSTEM');
      assert.equal(body.contents[0].parts[0].text, 'CUSTOM CONTENT');
    } finally {
      await server.close();
    }
  });

  it('skips thought parts and joins multiple text parts', async () => {
    const server = await startMockServer((_req, res) => {
      sseHeaders(res);
      res.end(
        event({ candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: 'Answer ' }, { text: 'here' }] }, finishReason: 'STOP' }] }),
      );
    });
    try {
      const result = await new GeminiProvider().ask({ ...baseParams, baseUrl: server.baseUrl, onDelta: () => undefined });
      assert.deepEqual(result, { status: 'done', text: 'Answer here' });
    } finally {
      await server.close();
    }
  });

  it('maps MAX_TOKENS, safety finish reasons and a blocked prompt', async () => {
    const run = async (payload: object) => {
      const server = await startMockServer((_req, res) => {
        sseHeaders(res);
        res.end(event(payload));
      });
      try {
        return await new GeminiProvider().ask({ ...baseParams, baseUrl: server.baseUrl, onDelta: () => undefined });
      } finally {
        await server.close();
      }
    };
    assert.deepEqual(await run({ ...part('cut'), candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }] }), {
      status: 'truncated',
      text: 'cut',
    });
    assert.deepEqual(await run({ candidates: [{ finishReason: 'SAFETY' }] }), {
      status: 'refused',
      text: '',
      category: 'SAFETY',
      explanation: null,
    });
    assert.deepEqual(await run({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }), {
      status: 'refused',
      text: '',
      category: 'PROHIBITED_CONTENT',
      explanation: 'The prompt was blocked.',
    });
  });

  it('redacts the key from HTTP errors', async () => {
    const server = await startMockServer((_req, res) =>
      json(res, 400, { error: { message: 'API key not valid: AIza-test-key' } }),
    );
    try {
      await assert.rejects(
        new GeminiProvider().ask({ ...baseParams, baseUrl: server.baseUrl, onDelta: () => undefined }),
        (err: unknown) =>
          err instanceof ProviderHttpError && err.status === 400 && !err.message.includes('AIza-test-key'),
      );
    } finally {
      await server.close();
    }
  });

  it('cancels on abort and keeps the partial text', async () => {
    const server = await startMockServer((_req, res) => {
      sseHeaders(res);
      res.write(event(part('partial'))); // then hang
    });
    try {
      const controller = new AbortController();
      const result = await new GeminiProvider().ask({
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

  it('requires a key, a model and a base URL', async () => {
    const p = new GeminiProvider();
    await assert.rejects(p.ask({ ...baseParams, apiKey: null, baseUrl: 'https://x.test', onDelta: () => undefined }), AiConfigError);
    await assert.rejects(p.ask({ ...baseParams, model: '', baseUrl: 'https://x.test', onDelta: () => undefined }), AiConfigError);
    await assert.rejects(p.ask({ ...baseParams, baseUrl: null, onDelta: () => undefined }), AiConfigError);
  });
});

describe('GeminiProvider.listModels', () => {
  it('follows pagination, keeps generateContent models, strips the prefix and sorts', async () => {
    const server = await startMockServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.searchParams.get('pageToken') === 'p2') {
        json(res, 200, { models: [{ name: 'models/gemini-a', displayName: 'Gemini A', supportedGenerationMethods: ['generateContent'] }] });
      } else {
        json(res, 200, {
          models: [
            { name: 'models/gemini-z', displayName: 'Gemini Z', supportedGenerationMethods: ['generateContent', 'countTokens'] },
            { name: 'models/embed-1', displayName: 'Embed', supportedGenerationMethods: ['embedContent'] },
          ],
          nextPageToken: 'p2',
        });
      }
    });
    try {
      const models = await new GeminiProvider().listModels({ apiKey: 'AIza-test-key', baseUrl: server.baseUrl });
      assert.deepEqual(models, [
        { id: 'gemini-a', displayName: 'Gemini A' },
        { id: 'gemini-z', displayName: 'Gemini Z' },
      ]);
      assert.equal(server.requests.length, 2);
      assert.match(server.requests[0]!.url, /key=AIza-test-key/);
      assert.match(server.requests[1]!.url, /pageToken=p2/);
    } finally {
      await server.close();
    }
  });

  it('stops after a bounded number of pages if the server never ends pagination', async () => {
    const server = await startMockServer((_req, res) => json(res, 200, { models: [], nextPageToken: 'again' }));
    try {
      await new GeminiProvider().listModels({ apiKey: 'k', baseUrl: server.baseUrl });
      assert.ok(server.requests.length <= 20);
    } finally {
      await server.close();
    }
  });
});
