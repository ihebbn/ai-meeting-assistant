import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { type AiClientLike, type AiStreamLike, AnthropicProvider } from './anthropic';

type FinalMessage = Awaited<ReturnType<AiStreamLike['finalMessage']>>;

function textEvent(text: string): unknown {
  return { type: 'content_block_delta', delta: { type: 'text_delta', text } };
}

function fakeClient(opts: {
  events?: unknown[];
  final?: FinalMessage;
  streamError?: Error;
  models?: Array<{
    id: string;
    display_name: string;
    created_at: string;
    deprecated_at?: string | null;
    capabilities?: { effort?: { supported?: boolean } } | null;
  }>;
}): { client: AiClientLike; calls: Anthropic.MessageStreamParams[]; aborted: { count: number } } {
  const calls: Anthropic.MessageStreamParams[] = [];
  const aborted = { count: 0 };
  const client: AiClientLike = {
    messages: {
      stream: (params) => {
        calls.push(params);
        const stream: AiStreamLike = {
          async *[Symbol.asyncIterator]() {
            for (const event of opts.events ?? []) {
              yield event;
            }
            if (opts.streamError) {
              throw opts.streamError;
            }
          },
          finalMessage: async () => opts.final ?? { stop_reason: 'end_turn' },
          abort: () => {
            aborted.count += 1;
          },
        };
        return stream;
      },
    },
    models: {
      list: () =>
        (async function* () {
          for (const m of opts.models ?? []) {
            yield m;
          }
        })(),
    },
  };
  return { client, calls, aborted };
}

const base = {
  question: 'What did they ask?',
  transcript: [{ speaker: 'System audio', text: 'Can you share your screen?' }],
  model: 'claude-opus-5-5',
  effort: 'medium' as const,
  apiKey: 'sk-ant-test',
  baseUrl: null,
};

describe('AnthropicProvider.ask', () => {
  it('streams deltas, returns the full text, and sends transcript as data', async () => {
    const { client, calls } = fakeClient({ events: [textEvent('Share '), textEvent('it.')] });
    const deltas: string[] = [];
    const result = await new AnthropicProvider(() => client).ask({ ...base, onDelta: (t) => deltas.push(t) });

    assert.deepEqual(deltas, ['Share ', 'it.']);
    assert.deepEqual(result, { status: 'done', text: 'Share it.' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.model, 'claude-opus-5-5');
    assert.match(String(calls[0]!.system), /untrusted data/);
    const content = String((calls[0]!.messages[0] as { content: unknown }).content);
    assert.ok(content.includes('System audio: Can you share your screen?'));
    assert.ok(content.includes('<question>\nWhat did they ask?\n</question>'));
  });

  it('ignores non-text events and omits effort and thinking by default', async () => {
    const { client, calls } = fakeClient({
      events: [{ type: 'message_start' }, { type: 'content_block_delta', delta: { type: 'input_json_delta' } }, textEvent('ok')],
    });
    const result = await new AnthropicProvider(() => client).ask({ ...base, onDelta: () => undefined });
    assert.equal(result.text, 'ok');
    assert.equal('output_config' in calls[0]!, false);
    assert.equal('thinking' in calls[0]!, false);
    assert.equal('temperature' in calls[0]!, false);
  });

  it('sends effort only for models the Models API reports as supporting it', async () => {
    const { client, calls } = fakeClient({
      events: [textEvent('x')],
      models: [
        { id: 'claude-opus-5-5', display_name: 'Opus', created_at: '2026-01-01', capabilities: { effort: { supported: true } } },
        { id: 'claude-haiku-4-5', display_name: 'Haiku 4.5', created_at: '2025-01-01', capabilities: { effort: { supported: false } } },
      ],
    });
    const service = new AnthropicProvider(() => client);
    await service.listModels({ apiKey: 'k', baseUrl: null });
    await service.ask({ ...base, effort: 'low', onDelta: () => undefined });
    assert.deepEqual(calls[0]!.output_config, { effort: 'low' });

    await service.ask({ ...base, model: 'claude-haiku-4-5', onDelta: () => undefined });
    assert.equal('output_config' in calls[1]!, false);
  });

  it('reports a refusal with its category', async () => {
    const { client } = fakeClient({
      events: [textEvent('partial')],
      final: { stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: 'declined' } },
    });
    const result = await new AnthropicProvider(() => client).ask({ ...base, onDelta: () => undefined });
    assert.deepEqual(result, { status: 'refused', text: 'partial', category: 'cyber', explanation: 'declined' });
  });

  it('flags a truncated answer', async () => {
    const { client } = fakeClient({ events: [textEvent('cut')], final: { stop_reason: 'max_tokens' } });
    const result = await new AnthropicProvider(() => client).ask({ ...base, onDelta: () => undefined });
    assert.deepEqual(result, { status: 'truncated', text: 'cut' });
  });

  it('aborts the stream when the signal fires and returns cancelled', async () => {
    const controller = new AbortController();
    const { client, aborted } = fakeClient({
      events: [textEvent('a')],
      streamError: new Anthropic.APIUserAbortError(),
    });
    const result = await new AnthropicProvider(() => client).ask({
      ...base,
      signal: controller.signal,
      onDelta: () => controller.abort(),
    });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.text, 'a');
    assert.equal(aborted.count, 1);
  });

  it('rethrows other errors', async () => {
    const { client } = fakeClient({ streamError: new Error('boom') });
    await assert.rejects(
      new AnthropicProvider(() => client).ask({ ...base, onDelta: () => undefined }),
      /boom/,
    );
  });

  it('passes the API key to the client factory', async () => {
    let seen: string | null | undefined;
    const { client } = fakeClient({ events: [textEvent('x')] });
    await new AnthropicProvider((key) => {
      seen = key;
      return client;
    }).ask({ ...base, apiKey: null, onDelta: () => undefined });
    assert.equal(seen, null);
  });
});

describe('AnthropicProvider.listModels', () => {
  it('keeps active claude models, newest first, with display names', async () => {
    const { client } = fakeClient({
      models: [
        { id: 'claude-old', display_name: 'Old', created_at: '2025-01-01' },
        { id: 'claude-new', display_name: 'New', created_at: '2026-06-01' },
        { id: 'claude-gone', display_name: 'Gone', created_at: '2026-07-01', deprecated_at: '2026-08-01' },
        { id: 'other-model', display_name: 'Other', created_at: '2026-09-01' },
      ],
    });
    assert.deepEqual(await new AnthropicProvider(() => client).listModels({ apiKey: null, baseUrl: null }), [
      { id: 'claude-new', displayName: 'New' },
      { id: 'claude-old', displayName: 'Old' },
    ]);
  });
});
