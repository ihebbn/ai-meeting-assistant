import type { TranscriptLine } from './prompt';

export type AiEffort = 'low' | 'medium' | 'high';

export type AiModelInfo = { id: string; displayName: string };

export type ProviderAuth = {
  /** null means "let the provider SDK resolve credentials from the environment". */
  apiKey: string | null;
  baseUrl: string | null;
};

export type AskParams = ProviderAuth & {
  question: string;
  transcript: readonly TranscriptLine[];
  model: string;
  effort: AiEffort;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
};

export type AskResult =
  | { status: 'done'; text: string }
  | { status: 'refused'; text: string; category: string | null; explanation: string | null }
  | { status: 'truncated'; text: string }
  | { status: 'cancelled'; text: string };

export interface AiProvider {
  /** Whether a reasoning-effort setting is meaningful for this provider. */
  readonly supportsEffort: boolean;
  listModels(auth: ProviderAuth): Promise<AiModelInfo[]>;
  ask(params: AskParams): Promise<AskResult>;
}

/** A problem the user can fix in Settings (missing model, missing base URL, ...). */
export class AiConfigError extends Error {}

/** A non-2xx response (or in-stream error) from a plain-HTTP provider. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
