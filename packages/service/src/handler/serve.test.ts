import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AsyncFallible } from '../errors/index.ts';
import { inputFromEnv, settingsFromEnv } from './env.ts';
import { matchRoute } from './match.ts';
import { serve, type Failure } from './serve.ts';
import { testEnv } from '../service.test-utils.ts';

const ROUTE = matchRoute('POST', '/api/ontology-service/v1/publish');

if (!ROUTE) throw new Error('Expected publish route match.');

const MATCH = ROUTE;

function runServe(request: Request, bodyLimits?: { readonly maxBytes?: number; readonly timeoutMs?: number }) {
  return serve(
    request,
    MATCH,
    async function* (readInput): AsyncFallible<Response, Failure> {
      const input = yield* readInput();

      return Response.json({ received: input.body });
    },
    () => undefined,
    () => ({}),
    bodyLimits,
  );
}

describe('serve JSON body limits and timeout', () => {
  afterEach(() => vi.useRealTimers());

  it('accepts a valid JSON body right at the configured byte limit', async () => {
    const payload = JSON.stringify({ data: 'a'.repeat(40) });
    const bytes = new TextEncoder().encode(payload).byteLength;

    const request = new Request('http://localhost/api/ontology-service/v1/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    const response = await runServe(request, { maxBytes: bytes });

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({ received: { data: 'a'.repeat(40) } });
  });

  it('returns 413 PayloadTooLarge and cancels streaming early without buffering trailing chunks', async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode('x'.repeat(64));

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;

        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    const request = new Request('http://localhost/api/ontology-service/v1/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    });

    const response = await runServe(request, { maxBytes: 100 });

    expect(response.status).toBe(413);

    expect(await response.json()).toMatchObject({
      errorCode: 'REQUEST_ENTITY_TOO_LARGE',
      errorName: 'PayloadTooLarge',
      parameters: { maxBytes: 100 },
    });

    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it('returns 413 PayloadTooLarge immediately when content-length exceeds the limit', async () => {
    const request = new Request('http://localhost/api/ontology-service/v1/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2048' },
      body: '{}',
    });

    const response = await runServe(request, { maxBytes: 100 });

    expect(response.status).toBe(413);

    expect(await response.json()).toMatchObject({
      errorCode: 'REQUEST_ENTITY_TOO_LARGE',
      errorName: 'PayloadTooLarge',
      parameters: { maxBytes: 100 },
    });
  });

  it('returns 408 RequestTimeout and cancels the stream when body reads stall past timeoutMs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let cancelled = false;

    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });

    const request = new Request('http://localhost/api/ontology-service/v1/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stalled,
      duplex: 'half',
    });

    const pending = runServe(request, { timeoutMs: 5_000 });

    await vi.advanceTimersByTimeAsync(5_000);

    const response = await pending;

    expect(response.status).toBe(408);

    expect(await response.json()).toMatchObject({
      errorCode: 'TIMEOUT',
      errorName: 'RequestTimeout',
      parameters: { timeoutMs: 5_000 },
    });

    expect(cancelled).toBe(true);
  });

  it('decodes a multibyte UTF-8 character split across two stream chunks', async () => {
    const payload = JSON.stringify({ label: 'café 🚀' });
    const bytes = new TextEncoder().encode(payload);
    const rocketStart = bytes.indexOf(0xf0);
    const splitAt = rocketStart + 2;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, splitAt));

        controller.enqueue(bytes.subarray(splitAt));

        controller.close();
      },
    });

    const request = new Request('http://localhost/api/ontology-service/v1/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    });

    const response = await runServe(request, { maxBytes: bytes.byteLength });

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({ received: { label: 'café 🚀' } });
  });

  it('parses ONTOS_MAX_BODY_BYTES from env and refuses invalid values', () => {
    expect(settingsFromEnv({ ...testEnv, ONTOS_MAX_BODY_BYTES: '1048576' }).maxBodyBytes).toBe(1_048_576);
    expect(settingsFromEnv(testEnv)).not.toHaveProperty('maxBodyBytes');
    expect(() => settingsFromEnv({ ...testEnv, ONTOS_MAX_BODY_BYTES: '0' })).toThrow('ONTOS_MAX_BODY_BYTES');

    expect(inputFromEnv({ ...testEnv, ONTOS_MAX_BODY_BYTES: 'abc' }, () => new pg.Pool())).toEqual({
      missing: ['ONTOS_MAX_BODY_BYTES'],
    });
  });
});
