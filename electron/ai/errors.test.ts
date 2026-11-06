import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { describeAiError, httpErrorFrom, messageFromErrorBody, redactSecret } from './errors';
import { AiConfigError, ProviderHttpError } from './types';

const ctx = { model: 'm-1', providerLabel: 'Acme' };

describe('messageFromErrorBody', () => {
  it('reads common error envelopes', () => {
    assert.equal(messageFromErrorBody('{"error":{"message":"bad key"}}'), 'bad key');
    assert.equal(messageFromErrorBody('{"error":"plain string"}'), 'plain string');
    assert.equal(messageFromErrorBody('{"message":"top level"}'), 'top level');
  });

  it('falls back to trimmed raw text and truncates', () => {
    assert.equal(messageFromErrorBody('  <html>Bad gateway</html> '), '<html>Bad gateway</html>');
    assert.equal(messageFromErrorBody('x'.repeat(1000)).length, 300);
  });
});

describe('redactSecret / httpErrorFrom', () => {
  it('redacts every occurrence and tolerates a missing secret', () => {
    assert.equal(redactSecret('a sk-1 b sk-1', 'sk-1'), 'a [redacted] b [redacted]');
    assert.equal(redactSecret('abc', null), 'abc');
  });

  it('builds an error with the status and a redacted message', async () => {
    const err = await httpErrorFrom(
      { status: 401, text: async () => '{"error":{"message":"key sk-secret is invalid"}}' },
      'sk-secret',
    );
    assert.equal(err.status, 401);
    assert.ok(!err.message.includes('sk-secret'));
    assert.match(err.message, /\[redacted\]/);
  });

  it('survives an unreadable body', async () => {
    const err = await httpErrorFrom(
      { status: 500, text: async () => Promise.reject(new Error('stream broke')) },
      null,
    );
    assert.equal(err.status, 500);
  });
});

describe('describeAiError', () => {
  it('maps HTTP provider statuses to actionable messages with the provider name', () => {
    const msg = (status: number, detail = 'detail') =>
      describeAiError(new ProviderHttpError(status, detail), ctx);
    assert.match(msg(401), /Acme API key was rejected/);
    assert.match(msg(403), /Acme API key was rejected/);
    assert.match(msg(404), /Model "m-1".* not found on Acme/);
    assert.match(msg(429), /Rate limited or out of quota on Acme/);
    assert.match(msg(400, 'bad param'), /Acme rejected the request \(bad param\)/);
    assert.match(msg(503), /Acme is having problems \(HTTP 503\)/);
    assert.match(msg(418), /Acme error \(HTTP 418\)/);
  });

  it('maps Anthropic SDK errors with the provider label', () => {
    const make = (status: number) =>
      Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: 'd' } }, 'd', new Headers());
    assert.match(describeAiError(make(401), ctx), /Acme API key was rejected/);
    assert.match(describeAiError(make(403), ctx), /not allowed/);
    assert.match(describeAiError(make(404), ctx), /Model "m-1" was not found on Acme/);
    assert.match(describeAiError(make(429), ctx), /Rate limited by Acme/);
    assert.match(describeAiError(make(400), ctx), /Acme rejected the request/);
    assert.match(describeAiError(new Anthropic.APIConnectionError({}), ctx), /Could not reach Acme/);
  });

  it('returns config errors verbatim, maps fetch failures, and wraps unknowns', () => {
    assert.equal(describeAiError(new AiConfigError('Pick a model.'), ctx), 'Pick a model.');
    assert.match(describeAiError(new TypeError('fetch failed'), ctx), /Could not reach Acme/);
    assert.match(describeAiError(new Error('x'), ctx), /Ask AI failed: x/);
  });

  it('never echoes an API key that was redacted upstream', () => {
    const msg = describeAiError(new ProviderHttpError(401, 'invalid [redacted]'), ctx);
    assert.ok(!msg.includes('sk-'));
  });
});
