import { httpErrorFrom, redactSecret } from '../errors';
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
import { isAbortError } from './openai-compatible';

/**
 * Google Gemini (generativelanguage.googleapis.com) over plain HTTP. EXPERIMENTAL: the
 * request shape and `?alt=sse&key=` come from Google's docs, but the exact stream chunk
 * shape, error body and header-based auth could not be confirmed without a live key, so
 * parsing is deliberately tolerant. Capture a real stream before relying on it.
 */
const SAFETY_FINISH_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII']);

export class GeminiProvider implements AiProvider {
  readonly supportsEffort = false;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private base(baseUrl: string | null): string {
    if (!baseUrl) {
      throw new AiConfigError('Set the API base URL for Google in Settings.');
    }
    return baseUrl.replace(/\/+$/, '');
  }

  private requireKey(apiKey: string | null): string {
    if (!apiKey) {
      throw new AiConfigError('Add a Google API key in Settings (or set GEMINI_API_KEY).');
    }
    return apiKey;
  }

  async listModels(auth: ProviderAuth): Promise<AiModelInfo[]> {
    const key = this.requireKey(auth.apiKey);
    const base = this.base(auth.baseUrl);
    const models: AiModelInfo[] = [];
    let pageToken: string | null = null;
    // Follow nextPageToken, with a hard cap so a misbehaving server cannot loop forever.
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ pageSize: '1000', key });
      if (pageToken) {
        query.set('pageToken', pageToken);
      }
      const res = await this.fetchImpl(`${base}/models?${query.toString()}`);
      if (!res.ok) {
        throw await httpErrorFrom(res, key);
      }
      const json = (await res.json()) as {
        models?: Array<{
          name?: unknown;
          displayName?: unknown;
          supportedGenerationMethods?: unknown;
        }>;
        nextPageToken?: unknown;
      };
      for (const m of json.models ?? []) {
        const methods = Array.isArray(m.supportedGenerationMethods)
          ? m.supportedGenerationMethods
          : [];
        if (typeof m.name !== 'string' || !methods.includes('generateContent')) {
          continue;
        }
        const id = m.name.replace(/^models\//, '');
        models.push({
          id,
          displayName: typeof m.displayName === 'string' && m.displayName ? m.displayName : id,
        });
      }
      pageToken = typeof json.nextPageToken === 'string' && json.nextPageToken ? json.nextPageToken : null;
      if (!pageToken) {
        break;
      }
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  async ask(params: AskParams): Promise<AskResult> {
    const key = this.requireKey(params.apiKey);
    if (!params.model) {
      throw new AiConfigError('Pick a model for Google in Settings.');
    }
    const url =
      `${this.base(params.baseUrl)}/models/${encodeURIComponent(params.model)}` +
      `:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
    let text = '';
    let finish: string | null = null;
    let blockReason: string | null = null;

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: params.system ?? SYSTEM_PROMPT }] },
          contents: [
            {
              role: 'user',
              parts: [
                { text: params.content ?? buildUserContent(params.question, params.transcript) },
              ],
            },
          ],
        }),
        signal: params.signal,
      });
      if (!res.ok) {
        throw await httpErrorFrom(res, key);
      }
      if (!res.body) {
        throw new ProviderHttpError(res.status, 'The response had no body.');
      }

      for await (const message of readSse(res.body as unknown as AsyncIterable<Uint8Array>)) {
        if (message.data === '[DONE]') {
          break; // not documented for this endpoint, harmless if present
        }
        let json: {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: unknown; thought?: unknown }> };
            finishReason?: unknown;
          }>;
          promptFeedback?: { blockReason?: unknown };
        };
        try {
          json = JSON.parse(message.data);
        } catch {
          continue;
        }
        if (typeof json.promptFeedback?.blockReason === 'string') {
          blockReason = json.promptFeedback.blockReason;
        }
        const candidate = json.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          // Skip thought summaries; keep every other text part.
          if (typeof part.text === 'string' && part.text && part.thought !== true) {
            text += part.text;
            params.onDelta(part.text);
          }
        }
        if (typeof candidate?.finishReason === 'string') {
          finish = candidate.finishReason;
        }
      }
    } catch (err) {
      if (isAbortError(err) || params.signal?.aborted) {
        return { status: 'cancelled', text };
      }
      if (err instanceof Error && !(err instanceof ProviderHttpError)) {
        // Network errors can echo the URL, which contains the key.
        err.message = redactSecret(err.message, key);
      }
      throw err;
    }

    if (blockReason) {
      return { status: 'refused', text, category: blockReason, explanation: 'The prompt was blocked.' };
    }
    if (finish && SAFETY_FINISH_REASONS.has(finish)) {
      return { status: 'refused', text, category: finish, explanation: null };
    }
    if (finish === 'MAX_TOKENS') {
      return { status: 'truncated', text };
    }
    return { status: 'done', text };
  }
}
