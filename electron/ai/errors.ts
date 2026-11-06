import Anthropic from '@anthropic-ai/sdk';
import { AiConfigError, ProviderHttpError } from './types';

/** Remove a secret from text that may be shown or logged (e.g. URLs, echoed errors). */
export function redactSecret(text: string, secret: string | null): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

/** Best-effort message from an error body: {error:{message}}, {error:"..."}, {message}, or text. */
export function messageFromErrorBody(body: string): string {
  const trimmed = body.trim();
  try {
    const json = JSON.parse(trimmed) as {
      error?: string | { message?: unknown };
      message?: unknown;
    };
    const fromError =
      typeof json.error === 'string'
        ? json.error
        : typeof json.error?.message === 'string'
          ? json.error.message
          : null;
    const message = fromError ?? (typeof json.message === 'string' ? json.message : null);
    if (message) {
      return message.slice(0, 500);
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return trimmed.slice(0, 300);
}

export async function httpErrorFrom(
  res: { status: number; text: () => Promise<string> },
  secret: string | null,
): Promise<ProviderHttpError> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    // Ignore body read failures; the status is what matters.
  }
  return new ProviderHttpError(res.status, redactSecret(messageFromErrorBody(body), secret));
}

export type ErrorContext = { model: string; providerLabel: string };

/** User-facing message for any provider failure. Never includes an API key. */
export function describeAiError(err: unknown, ctx: ErrorContext): string {
  const { model, providerLabel: label } = ctx;
  if (err instanceof AiConfigError) {
    return err.message;
  }
  if (err instanceof ProviderHttpError) {
    return describeHttpStatus(err.status, err.message, ctx);
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return `The ${label} API key was rejected. Check it in Settings.`;
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return `This ${label} API key is not allowed to use that model or feature.`;
  }
  if (err instanceof Anthropic.NotFoundError) {
    return `Model "${model}" was not found on ${label}. Pick another model in Settings.`;
  }
  if (err instanceof Anthropic.RateLimitError) {
    return `Rate limited by ${label}. Try again in a moment.`;
  }
  if (err instanceof Anthropic.BadRequestError) {
    return `${label} rejected the request: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return `Could not reach ${label}. Check your network connection.`;
  }
  if (err instanceof Anthropic.APIError) {
    return `${label} error${err.status ? ` ${err.status}` : ''}: ${err.message}`;
  }
  // Node's fetch reports network failures as TypeError("fetch failed").
  if (err instanceof TypeError) {
    return `Could not reach ${label}. Check your network connection and the base URL.`;
  }
  return `Ask AI failed: ${err instanceof Error ? err.message : String(err)}`;
}

function describeHttpStatus(status: number, detail: string, ctx: ErrorContext): string {
  const { model, providerLabel: label } = ctx;
  const suffix = detail ? ` (${detail})` : '';
  if (status === 401 || status === 403) {
    return `The ${label} API key was rejected or is not allowed to do this${suffix}. Check it in Settings.`;
  }
  if (status === 404) {
    return `Model "${model}" or the endpoint was not found on ${label}${suffix}. Pick another model or check the base URL.`;
  }
  if (status === 429) {
    return `Rate limited or out of quota on ${label}${suffix}.`;
  }
  if (status === 400 || status === 422) {
    return `${label} rejected the request${suffix}.`;
  }
  if (status >= 500) {
    return `${label} is having problems (HTTP ${status})${suffix}. Try again shortly.`;
  }
  return `${label} error (HTTP ${status})${suffix}.`;
}
