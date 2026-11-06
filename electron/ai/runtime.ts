import type { AppSettings } from '../settings';
import type { CredentialStore } from './credentials';
import type { ErrorContext } from './errors';
import { type ProviderDef, type ProviderKind, PROVIDERS, getProvider } from './registry';
import {
  AiConfigError,
  type AiEffort,
  type AiModelInfo,
  type AiProvider,
  type AskResult,
} from './types';
import {
  SUGGEST_SYSTEM_PROMPT,
  type TranscriptLine,
  buildSuggestContent,
  parseSuggestions,
} from './prompt';

export type KeySource = 'stored' | 'env' | null;

export type ProviderSummary = { id: string; label: string; experimental: boolean };

/** Everything the Settings UI needs. It never contains an API key. */
export type AiState = {
  providers: ProviderSummary[];
  provider: string;
  providerLabel: string;
  note: string | null;
  experimental: boolean;
  /** Ask AI can call the provider (a key is available, or none is needed). */
  configured: boolean;
  keySource: KeySource;
  /** Whether a pasted key can be stored securely on this machine. */
  canStoreKey: boolean;
  model: string;
  effort: AiEffort;
  supportsEffort: boolean;
  baseUrl: string | null;
  baseUrlEditable: boolean;
  /** Refresh suggestions automatically while listening (sends transcript on its own). */
  autoSuggest: boolean;
};

type RuntimeDeps = {
  providers: Record<ProviderKind, AiProvider>;
  credentials: (providerId: string) => CredentialStore;
  settings: () => AppSettings;
  env: NodeJS.ProcessEnv;
};

/**
 * Resolves the selected provider, model, key and base URL for Ask AI and owns request
 * cancellation. The renderer never sees a key: it can only save, clear, and ask whether
 * one is configured.
 */
export class AiRuntime {
  private controller: AbortController | null = null;
  private suggestController: AbortController | null = null;

  constructor(private readonly deps: RuntimeDeps) {}

  active(): ProviderDef {
    return getProvider(this.deps.settings().aiProvider);
  }

  baseUrl(def: ProviderDef = this.active()): string | null {
    return this.deps.settings().aiBaseUrls[def.id] ?? def.baseUrl;
  }

  model(def: ProviderDef = this.active()): string {
    return this.deps.settings().aiModels[def.id] ?? def.defaultModel ?? '';
  }

  /**
   * Stored key wins, then the provider's environment variables. For Anthropic the SDK
   * resolves environment credentials itself, so no key is passed.
   */
  resolveKey(def: ProviderDef = this.active()): { apiKey: string | null; source: KeySource } {
    const stored = this.deps.credentials(def.id).load();
    if (stored) {
      return { apiKey: stored, source: 'stored' };
    }
    for (const name of def.envVars) {
      const value = this.deps.env[name]?.trim();
      if (value) {
        return { apiKey: def.kind === 'anthropic' ? null : value, source: 'env' };
      }
    }
    return { apiKey: null, source: null };
  }

  isConfigured(): boolean {
    const def = this.active();
    return this.resolveKey(def).source !== null || (def.keyOptional && !!this.baseUrl(def));
  }

  getState(): AiState {
    const def = this.active();
    const settings = this.deps.settings();
    return {
      providers: PROVIDERS.map(({ id, label, experimental }) => ({ id, label, experimental })),
      provider: def.id,
      providerLabel: def.label,
      note: def.note,
      experimental: def.experimental,
      configured: this.isConfigured(),
      keySource: this.resolveKey(def).source,
      canStoreKey: this.deps.credentials(def.id).canStore(),
      model: this.model(def),
      effort: settings.aiEffort,
      supportsEffort: this.deps.providers[def.kind].supportsEffort,
      baseUrl: this.baseUrl(def),
      baseUrlEditable: def.baseUrlEditable,
      autoSuggest: settings.aiAutoSuggest,
    };
  }

  /** Label and model for error messages. */
  errorContext(): ErrorContext {
    const def = this.active();
    return { model: this.model(def), providerLabel: def.label };
  }

  saveKey(apiKey: string): void {
    this.deps.credentials(this.active().id).save(apiKey);
  }

  clearKey(): void {
    this.deps.credentials(this.active().id).clear();
  }

  listModels(): Promise<AiModelInfo[]> {
    const def = this.active();
    const { apiKey, source } = this.resolveKey(def);
    if (source === null && !def.keyOptional) {
      throw new AiConfigError(`Add a ${def.label} API key first.`);
    }
    return this.deps.providers[def.kind].listModels({ apiKey, baseUrl: this.baseUrl(def) });
  }

  /** Starts a request, cancelling any one still in flight. */
  async ask(options: {
    question: string;
    transcript: readonly TranscriptLine[];
    onDelta: (text: string) => void;
  }): Promise<AskResult> {
    const def = this.active();
    const model = this.model(def);
    if (!model) {
      throw new AiConfigError(`Pick a model for ${def.label} in Settings.`);
    }
    const { apiKey } = this.resolveKey(def);
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    try {
      return await this.deps.providers[def.kind].ask({
        ...options,
        model,
        effort: this.deps.settings().aiEffort,
        apiKey,
        baseUrl: this.baseUrl(def),
        signal: controller.signal,
      });
    } finally {
      if (this.controller === controller) {
        this.controller = null;
      }
    }
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /**
   * Suggestions grounded on the recent transcript. Runs at low effort, independently of
   * answers (neither cancels the other), and a newer call supersedes an older one.
   * Returns an empty list when the model declines or has nothing grounded to suggest.
   */
  async suggest(transcript: readonly TranscriptLine[]): Promise<string[]> {
    const def = this.active();
    const model = this.model(def);
    if (!model) {
      throw new AiConfigError(`Pick a model for ${def.label} in Settings.`);
    }
    const { apiKey } = this.resolveKey(def);
    this.suggestController?.abort();
    const controller = new AbortController();
    this.suggestController = controller;
    try {
      const result = await this.deps.providers[def.kind].ask({
        question: '',
        transcript,
        system: SUGGEST_SYSTEM_PROMPT,
        content: buildSuggestContent(transcript),
        onDelta: () => undefined,
        model,
        effort: 'low',
        apiKey,
        baseUrl: this.baseUrl(def),
        signal: controller.signal,
      });
      return result.status === 'done' || result.status === 'truncated'
        ? parseSuggestions(result.text)
        : [];
    } finally {
      if (this.suggestController === controller) {
        this.suggestController = null;
      }
    }
  }

  cancelSuggestions(): void {
    this.suggestController?.abort();
    this.suggestController = null;
  }
}
