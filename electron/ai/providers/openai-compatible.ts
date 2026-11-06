import { httpErrorFrom, messageFromErrorBody } from '../errors';
import { SYSTEM_PROMPT, buildUserContent } from '../prompt';
import { readSse } from '../sse';
import {
  AiConfigError,
  type AiModelInfo,
  type AiProvider,
  type AskParams,
  type AskResult,
  ProviderHttpError,
  type ProviderAuth,
} from '../types';

/**
 * Chat Completions over plain HTTP: OpenAI, Mistral, Groq, OpenRouter, DeepSeek, Together
 * and any custom endpoint that speaks the same protocol (Bearer auth, `stream: true` SSE
 * with `choices[].delta.content`, `GET {base}/models`).
 *
 * Deliberately sends only model, messages and stream: token-limit and reasoning parameters
 * differ between providers and between models (e.g. max_tokens vs max_completion_tokens),
 * so the provider defaults are used.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly supportsEffort = false;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private base(baseUrl: string | null): string {
    if (!baseUrl) {
      throw new AiConfigError('Set the API base URL for this provider in Settings.');
    }
    return baseUrl.replace(/\/+$/, '');
  }

  private headers(apiKey: string | null): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
  }

  async listModels(auth: ProviderAuth): Promise<AiModelInfo[]> {
    const res = await this.fetchImpl(`${this.base(auth.baseUrl)}/models`, {
      headers: this.headers(auth.apiKey),
    });
    if (!res.ok) {
      throw await httpErrorFrom(res, auth.apiKey);
    }
    const json = (await res.json()) as { data?: unknown };
    const items = Array.isArray(json.data) ? json.data : [];
    const seen = new Set<string>();
    const models: Array<AiModelInfo & { created: number }> = [];
    for (const item of items) {
      const m = item as { id?: unknown; name?: unknown; created?: unknown };
      if (typeof m.id !== 'string' || !m.id || seen.has(m.id)) {
        continue;
      }
      seen.add(m.id);
      models.push({
        id: m.id,
        displayName: typeof m.name === 'string' && m.name ? m.name : m.id,
        created: typeof m.created === 'number' ? m.created : 0,
      });
    }
    // Newest first when the provider reports creation time, otherwise alphabetical.
    return models
      .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
      .map(({ id, displayName }) => ({ id, displayName }));
  }

  async ask(params: AskParams): Promise<AskResult> {
    if (!params.model) {
      throw new AiConfigError('Pick a model for this provider in Settings.');
    }
    const url = `${this.base(params.baseUrl)}/chat/completions`;
    let text = '';
    let finish: string | null = null;
    let refusal = '';

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(params.apiKey),
        body: JSON.stringify({
          model: params.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserContent(params.question, params.transcript) },
          ],
          stream: true,
        }),
        signal: params.signal,
      });
      if (!res.ok) {
        throw await httpErrorFrom(res, params.apiKey);
      }
      if (!res.body) {
        throw new ProviderHttpError(res.status, 'The response had no body.');
      }

      for await (const message of readSse(res.body as unknown as AsyncIterable<Uint8Array>)) {
        if (message.data === '[DONE]') {
          break;
        }
        let json: {
          choices?: Array<{
            delta?: { content?: unknown; refusal?: unknown };
            finish_reason?: unknown;
          }>;
          error?: unknown;
        };
        try {
          json = JSON.parse(message.data);
        } catch {
          continue; // ignore non-JSON keep-alives
        }
        if (json.error) {
          const detail = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
          throw new ProviderHttpError(0, redactInline(messageFromErrorBody(detail), params.apiKey));
        }
        const choice = json.choices?.[0];
        const delta = choice?.delta;
        if (typeof delta?.content === 'string' && delta.content) {
          text += delta.content;
          params.onDelta(delta.content);
        }
        if (typeof delta?.refusal === 'string' && delta.refusal) {
          refusal += delta.refusal;
        }
        if (typeof choice?.finish_reason === 'string') {
          finish = choice.finish_reason;
        }
      }
    } catch (err) {
      if (isAbortError(err) || params.signal?.aborted) {
        return { status: 'cancelled', text };
      }
      throw err;
    }

    if (refusal) {
      return { status: 'refused', text, category: null, explanation: refusal };
    }
    if (finish === 'content_filter') {
      return { status: 'refused', text, category: 'content_filter', explanation: null };
    }
    if (finish === 'length') {
      return { status: 'truncated', text };
    }
    return { status: 'done', text };
  }
}

function redactInline(text: string, secret: string | null): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'APIUserAbortError');
}
