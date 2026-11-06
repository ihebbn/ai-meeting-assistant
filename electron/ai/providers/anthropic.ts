import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, buildUserContent } from '../prompt';
import type {
  AiModelInfo,
  AiProvider,
  AskParams,
  AskResult,
  ProviderAuth,
} from '../types';

/** Narrow views of the SDK surface we use, so tests can inject a fake client. */
export type AiStreamLike = AsyncIterable<unknown> & {
  finalMessage: () => Promise<{
    stop_reason: string | null;
    stop_details?: { category?: string | null; explanation?: string | null } | null;
  }>;
  abort: () => void;
};

export type AiClientLike = {
  messages: { stream: (params: Anthropic.MessageStreamParams) => AiStreamLike };
  models: {
    list: () => AsyncIterable<{
      id: string;
      display_name: string;
      created_at: string;
      deprecated_at?: string | null;
      capabilities?: { effort?: { supported?: boolean } | null } | null;
    }>;
  };
};

export type AiClientFactory = (apiKey: string | null) => AiClientLike;

/** Output budget. Thinking tokens count against it, so it is deliberately generous. */
const MAX_OUTPUT_TOKENS = 16_000;

export const defaultClientFactory: AiClientFactory = (apiKey) =>
  // With no explicit key the SDK resolves ANTHROPIC_API_KEY / auth token from the environment.
  new Anthropic(apiKey ? { apiKey } : undefined);

function isTextDelta(event: unknown): event is { delta: { text: string } } {
  if (!event || typeof event !== 'object') {
    return false;
  }
  const e = event as { type?: unknown; delta?: { type?: unknown; text?: unknown } };
  return (
    e.type === 'content_block_delta' &&
    e.delta?.type === 'text_delta' &&
    typeof e.delta.text === 'string'
  );
}

/** Claude through the official Anthropic SDK. */
export class AnthropicProvider implements AiProvider {
  readonly supportsEffort = true;

  /** Models known to accept `output_config.effort`; learned from the Models API. */
  private readonly effortSupport = new Map<string, boolean>();

  constructor(private readonly createClient: AiClientFactory = defaultClientFactory) {}

  /** Claude models for the picker, newest first, non-deprecated only. */
  async listModels(auth: ProviderAuth): Promise<AiModelInfo[]> {
    const client = this.createClient(auth.apiKey);
    const found: Array<AiModelInfo & { createdAt: string }> = [];
    for await (const model of client.models.list()) {
      this.effortSupport.set(model.id, model.capabilities?.effort?.supported === true);
      if (model.deprecated_at || !model.id.startsWith('claude-')) {
        continue;
      }
      found.push({
        id: model.id,
        displayName: model.display_name || model.id,
        createdAt: model.created_at,
      });
    }
    return found
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ id, displayName }) => ({ id, displayName }));
  }

  async ask(options: AskParams): Promise<AskResult> {
    const client = this.createClient(options.apiKey);
    const params: Anthropic.MessageStreamParams = {
      model: options.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: options.system ?? SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: options.content ?? buildUserContent(options.question, options.transcript),
        },
      ],
      // Only send effort where the model is known to support it (older models reject it).
      // `thinking` is intentionally omitted: it is the safe default across current models.
      ...(this.effortSupport.get(options.model) === true
        ? { output_config: { effort: options.effort } }
        : {}),
    };

    const stream = client.messages.stream(params);
    const onAbort = () => stream.abort();
    if (options.signal?.aborted) {
      stream.abort();
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let text = '';
    try {
      for await (const event of stream) {
        if (isTextDelta(event)) {
          text += event.delta.text;
          options.onDelta(event.delta.text);
        }
      }
      const message = await stream.finalMessage();
      // Check stop_reason before trusting the content.
      if (message.stop_reason === 'refusal') {
        return {
          status: 'refused',
          text,
          category: message.stop_details?.category ?? null,
          explanation: message.stop_details?.explanation ?? null,
        };
      }
      if (message.stop_reason === 'max_tokens') {
        return { status: 'truncated', text };
      }
      return { status: 'done', text };
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError || options.signal?.aborted) {
        return { status: 'cancelled', text };
      }
      throw err;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}
