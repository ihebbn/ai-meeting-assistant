import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_SETTINGS, type AppSettings } from '../settings';
import type { CredentialStore } from './credentials';
import { AiRuntime } from './runtime';
import {
  AiConfigError,
  type AiProvider,
  type AskParams,
  type AskResult,
  type ProviderAuth,
} from './types';

function store(initial: string | null, canStore = true): CredentialStore & { key: string | null } {
  const s = {
    key: initial,
    canStore: () => canStore,
    has: () => s.key !== null,
    load: () => s.key,
    save: (k: string) => {
      s.key = k.trim();
    },
    clear: () => {
      s.key = null;
    },
  };
  return s;
}

function fakeProvider(over: Partial<AiProvider> = {}): AiProvider {
  return {
    supportsEffort: false,
    listModels: async () => [],
    ask: async () => ({ status: 'done', text: '' }),
    ...over,
  };
}

function runtime(opts: {
  settings?: Partial<AppSettings>;
  stores?: Record<string, CredentialStore>;
  env?: NodeJS.ProcessEnv;
  providers?: Partial<Record<'anthropic' | 'openai-compatible' | 'gemini', AiProvider>>;
}): AiRuntime {
  const stores = opts.stores ?? {};
  return new AiRuntime({
    providers: {
      anthropic: fakeProvider({ supportsEffort: true }),
      'openai-compatible': fakeProvider(),
      gemini: fakeProvider(),
      ...opts.providers,
    },
    credentials: (id) => stores[id] ?? (stores[id] = store(null)),
    settings: () => ({ ...DEFAULT_SETTINGS, ...opts.settings }),
    env: opts.env ?? {},
  });
}

describe('AiRuntime provider selection', () => {
  it('defaults to Anthropic with its default model', () => {
    const state = runtime({}).getState();
    assert.equal(state.provider, 'anthropic');
    assert.equal(state.model, 'claude-opus-5-5');
    assert.equal(state.supportsEffort, true);
  });

  it('uses the per-provider model and has no default model for others', () => {
    const r = runtime({
      settings: { aiProvider: 'mistral', aiModels: { mistral: 'some-model', anthropic: 'claude-x' } },
    });
    assert.equal(r.getState().model, 'some-model');
    assert.equal(runtime({ settings: { aiProvider: 'groq' } }).getState().model, '');
  });

  it('falls back to the first provider for an unknown id', () => {
    assert.equal(runtime({ settings: { aiProvider: 'nope' } }).getState().provider, 'anthropic');
  });

  it('exposes the provider list without any secret', () => {
    const state = runtime({ stores: { anthropic: store('sk-secret') } }).getState();
    assert.ok(state.providers.length >= 8);
    assert.ok(state.providers.some((p) => p.id === 'custom'));
    assert.ok(!JSON.stringify(state).includes('sk-secret'));
  });
});

describe('AiRuntime key resolution', () => {
  it('prefers the stored key over the environment', () => {
    const r = runtime({
      settings: { aiProvider: 'openai' },
      stores: { openai: store('sk-stored') },
      env: { OPENAI_API_KEY: 'sk-env' },
    });
    assert.deepEqual(r.resolveKey(), { apiKey: 'sk-stored', source: 'stored' });
  });

  it('reads the provider environment variable itself for non-Anthropic providers', () => {
    const r = runtime({ settings: { aiProvider: 'mistral' }, env: { MISTRAL_API_KEY: ' sk-env ' } });
    assert.deepEqual(r.resolveKey(), { apiKey: 'sk-env', source: 'env' });
  });

  it('leaves Anthropic environment resolution to the SDK (no key passed)', () => {
    assert.deepEqual(runtime({ env: { ANTHROPIC_API_KEY: 'sk-env' } }).resolveKey(), { apiKey: null, source: 'env' });
    assert.deepEqual(runtime({ env: { ANTHROPIC_AUTH_TOKEN: 'tok' } }).resolveKey(), { apiKey: null, source: 'env' });
  });

  it('honours variable order (Google: GOOGLE_API_KEY wins)', () => {
    const r = runtime({
      settings: { aiProvider: 'google' },
      env: { GEMINI_API_KEY: 'gem', GOOGLE_API_KEY: 'goo' },
    });
    assert.equal(r.resolveKey().apiKey, 'goo');
  });

  it('does not use another provider\'s key or variable', () => {
    const r = runtime({
      settings: { aiProvider: 'openai' },
      stores: { anthropic: store('sk-ant') },
      env: { ANTHROPIC_API_KEY: 'sk-ant-env' },
    });
    assert.equal(r.isConfigured(), false);
  });

  it('custom endpoints are configured once a base URL is set, with or without a key', () => {
    assert.equal(runtime({ settings: { aiProvider: 'custom' } }).isConfigured(), false);
    const r = runtime({ settings: { aiProvider: 'custom', aiBaseUrls: { custom: 'https://x.test/v1' } } });
    assert.equal(r.isConfigured(), true);
    assert.equal(r.getState().baseUrlEditable, true);
  });

  it('saves and clears the key of the active provider only', () => {
    const stores = { openai: store(null), mistral: store(null) };
    const r = runtime({ settings: { aiProvider: 'openai' }, stores });
    r.saveKey('  sk-new ');
    assert.equal(stores.openai.key, 'sk-new');
    assert.equal(stores.mistral.key, null);
    r.clearKey();
    assert.equal(stores.openai.key, null);
  });
});

describe('AiRuntime.listModels', () => {
  it('requires a key unless the provider allows none', () => {
    assert.throws(() => runtime({ settings: { aiProvider: 'openai' } }).listModels(), AiConfigError);
  });

  it('passes key and base URL to the provider', async () => {
    let seen: ProviderAuth | null = null;
    const r = runtime({
      settings: { aiProvider: 'openai' },
      stores: { openai: store('sk-1') },
      providers: {
        'openai-compatible': fakeProvider({
          listModels: async (auth) => {
            seen = auth;
            return [{ id: 'm', displayName: 'M' }];
          },
        }),
      },
    });
    assert.deepEqual(await r.listModels(), [{ id: 'm', displayName: 'M' }]);
    assert.deepEqual(seen, { apiKey: 'sk-1', baseUrl: 'https://api.openai.com/v1' });
  });
});

describe('AiRuntime.ask', () => {
  const base = { question: 'q', transcript: [], onDelta: () => undefined };

  it('requires a model for providers without a default', async () => {
    const r = runtime({ settings: { aiProvider: 'groq' }, stores: { groq: store('k') } });
    await assert.rejects(r.ask(base), /Pick a model for Groq/);
  });

  it('routes to the selected provider with model, effort, key, base URL and a signal', async () => {
    let seen: AskParams | null = null;
    const r = runtime({
      settings: { aiProvider: 'mistral', aiModels: { mistral: 'mm' }, aiEffort: 'low' },
      stores: { mistral: store('sk-m') },
      providers: {
        'openai-compatible': fakeProvider({
          ask: async (p) => {
            seen = p;
            return { status: 'done', text: 'ok' } as AskResult;
          },
        }),
      },
    });
    assert.deepEqual(await r.ask(base), { status: 'done', text: 'ok' });
    assert.equal(seen!.model, 'mm');
    assert.equal(seen!.effort, 'low');
    assert.equal(seen!.apiKey, 'sk-m');
    assert.equal(seen!.baseUrl, 'https://api.mistral.ai/v1');
    assert.ok(seen!.signal instanceof AbortSignal);
  });

  it('cancels the previous request when a new one starts, and on cancel()', async () => {
    const signals: AbortSignal[] = [];
    const r = runtime({
      stores: { anthropic: store('k') },
      providers: {
        anthropic: fakeProvider({
          ask: (p) =>
            new Promise<AskResult>((resolve) => {
              signals.push(p.signal!);
              p.signal!.addEventListener('abort', () => resolve({ status: 'cancelled', text: '' }));
              if (signals.length === 2) {
                resolve({ status: 'done', text: 'second' });
              }
            }),
        }),
      },
    });
    const first = r.ask(base);
    const second = r.ask(base);
    assert.equal(signals[0]!.aborted, true);
    assert.equal(signals[1]!.aborted, false);
    assert.equal((await first).status, 'cancelled');
    assert.equal((await second).status, 'done');

    const third = r.ask(base);
    r.cancel();
    assert.equal(signals[2]!.aborted, true);
    assert.equal((await third).status, 'cancelled');
  });

  it('errorContext names the active provider and model', () => {
    const r = runtime({ settings: { aiProvider: 'deepseek', aiModels: { deepseek: 'dm' } } });
    assert.deepEqual(r.errorContext(), { model: 'dm', providerLabel: 'DeepSeek' });
  });
});

describe('AiRuntime.suggest', () => {
  const transcript = [
    { speaker: 'System audio', text: 'We need to reduce churn this quarter.' },
    { speaker: 'You', text: 'What is our current ARR?' },
  ];

  it('uses the suggestion prompt at low effort and parses the reply', async () => {
    let seen: AskParams | null = null;
    const r = runtime({
      settings: { aiEffort: 'high' },
      stores: { anthropic: store('k') },
      providers: {
        anthropic: fakeProvider({
          supportsEffort: true,
          ask: async (p) => {
            seen = p;
            return { status: 'done', text: '- Define churn\n- Explain ARR\n' } as AskResult;
          },
        }),
      },
    });
    assert.deepEqual(await r.suggest(transcript), ['Define churn', 'Explain ARR']);
    assert.equal(seen!.effort, 'low');
    assert.match(seen!.system!, /up to 4 short things/);
    assert.ok(seen!.content!.includes('System audio: We need to reduce churn this quarter.'));
    assert.ok(!seen!.content!.includes('<question>'));
  });

  it('returns nothing when the model declines, and keeps text when truncated', async () => {
    const make = (result: AskResult) =>
      runtime({
        stores: { anthropic: store('k') },
        providers: { anthropic: fakeProvider({ ask: async () => result }) },
      });
    assert.deepEqual(
      await make({ status: 'refused', text: 'Define churn', category: null, explanation: null }).suggest(transcript),
      [],
    );
    assert.deepEqual(await make({ status: 'truncated', text: 'Define churn\nExplain A' }).suggest(transcript), [
      'Define churn',
      'Explain A',
    ]);
  });

  it('requires a model for providers without a default', async () => {
    const r = runtime({ settings: { aiProvider: 'groq' }, stores: { groq: store('k') } });
    await assert.rejects(r.suggest(transcript), /Pick a model for Groq/);
  });

  it('does not cancel an answer in flight, and a newer suggestion supersedes an older one', async () => {
    const signals: Array<{ kind: string; signal: AbortSignal }> = [];
    const r = runtime({
      stores: { anthropic: store('k') },
      providers: {
        anthropic: fakeProvider({
          ask: (p) =>
            new Promise<AskResult>((resolve) => {
              signals.push({ kind: p.system ? 'suggest' : 'answer', signal: p.signal! });
              p.signal!.addEventListener('abort', () => resolve({ status: 'cancelled', text: '' }));
              if (signals.length === 3) {
                resolve({ status: 'done', text: 'Define churn' });
              }
            }),
        }),
      },
    });
    const answer = r.ask({ question: 'q', transcript, onDelta: () => undefined });
    const first = r.suggest(transcript);
    const second = r.suggest(transcript);
    assert.equal(signals[0]!.signal.aborted, false); // the answer
    assert.equal(signals[1]!.signal.aborted, true); // superseded suggestion
    assert.equal(signals[2]!.signal.aborted, false);
    assert.deepEqual(await first, []);
    assert.deepEqual(await second, ['Define churn']);
    r.cancel();
    assert.equal((await answer).status, 'cancelled');
  });

  it('cancelSuggestions aborts a pending suggestion', async () => {
    let signal: AbortSignal | undefined;
    const r = runtime({
      stores: { anthropic: store('k') },
      providers: {
        anthropic: fakeProvider({
          ask: (p) =>
            new Promise<AskResult>((resolve) => {
              signal = p.signal;
              p.signal!.addEventListener('abort', () => resolve({ status: 'cancelled', text: '' }));
            }),
        }),
      },
    });
    const pending = r.suggest(transcript);
    r.cancelSuggestions();
    assert.equal(signal!.aborted, true);
    assert.deepEqual(await pending, []);
  });

  it('exposes the auto-suggest setting in state', () => {
    assert.equal(runtime({}).getState().autoSuggest, false);
    assert.equal(runtime({ settings: { aiAutoSuggest: true } }).getState().autoSuggest, true);
  });
});
