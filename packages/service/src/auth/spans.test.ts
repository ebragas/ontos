import { SpanStatusCode } from '@opentelemetry/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate, getUsersBatch, type KeySource, listOrganizations, remoteKeys, workosUsers } from './index.ts';
import { workosServer } from './workosServer.test-utils.ts';
import { span, type FinishedSpan } from '../spans/index.ts';
import { given, MEMBER, promised, rejecting, testSettings } from '../service.test-utils.ts';
import { createTestIssuer, ORGANIZATION, PERSON, SERVICE_USER, type TestIssuer } from '../tokens.test-utils.ts';
import { recordSpans, type SpanRecorder } from '../tracing.test-utils.ts';
import { STUB_PERSON, STUB_WORKOS_KEY, stubWorkos } from '../workos.test-utils.ts';

const answerWorkos = workosServer();

let recorder: SpanRecorder;
let issuer: TestIssuer;

beforeAll(async () => {
  recorder = recordSpans();

  issuer = await createTestIssuer(testSettings.auth);
});

beforeEach(() => recorder.reset());

afterAll(() => recorder.stop());

function shapes(spans: readonly FinishedSpan[]): unknown[] {
  return spans.map((span) => ({
    name: span.name,
    parent: spans.find((parent) => parent.spanId === span.parentSpanId)?.name,
    status: span.status.code,
    attributes: span.attributes,
  }));
}

const bearer = (token: string) =>
  new Request('http://localhost/api/v2/ontologies', { headers: { authorization: `Bearer ${token}` } });

function servedKeys(): KeySource {
  answerWorkos(() => Response.json(issuer.jwks.workos));

  return remoteKeys(testSettings.auth);
}

describe('the token check', () => {
  it('service/observability#traces: a key cache miss gives a token check span with 1 jwks fetch child, and a cache hit gives none', async () => {
    const keys = servedKeys();

    await rejecting(authenticate(bearer(await issuer.workos()), testSettings.auth, keys));

    expect(shapes(recorder.spans())).toEqual([
      {
        name: 'jwks fetch',
        parent: 'token check',
        status: SpanStatusCode.UNSET,
        attributes: { 'http.status_code': 200, 'sentry.op': 'http.client' },
      },
      {
        name: 'token check',
        parent: undefined,
        status: SpanStatusCode.UNSET,
        attributes: { 'sentry.op': 'middleware' },
      },
    ]);

    recorder.reset();

    await rejecting(authenticate(bearer(await issuer.workos()), testSettings.auth, keys));

    expect(shapes(recorder.spans())).toEqual([
      {
        name: 'token check',
        parent: undefined,
        status: SpanStatusCode.UNSET,
        attributes: { 'sentry.op': 'middleware' },
      },
    ]);
  });

  it('service/observability#traces: the key source of the adapters fetches with the global fetch, in a jwks fetch span', async () => {
    let calls = 0;

    answerWorkos(() => {
      calls += 1;

      return Response.json(issuer.jwks.workos);
    });

    await rejecting(authenticate(bearer(await issuer.workos()), testSettings.auth, remoteKeys(testSettings.auth)));

    expect({ calls, names: recorder.spans().map((span) => span.name) }).toEqual({
      calls: 1,
      names: ['jwks fetch', 'token check'],
    });
  });

  it('service/observability#traces: a token that fails a check ends its token check span with the error type', async () => {
    await expect(
      rejecting(authenticate(bearer(await issuer.workos({}, { key: 'stranger' })), testSettings.auth, servedKeys())),
    ).rejects.toMatchObject({ errorName: 'Default:Unauthorized' });

    expect(shapes(recorder.spans()).at(-1)).toEqual({
      name: 'token check',
      parent: undefined,
      status: SpanStatusCode.ERROR,
      attributes: { 'error.type': 'Default:Unauthorized', 'sentry.op': 'middleware' },
    });
  });
});

describe('the WorkOS reads', () => {
  const users = () => workosUsers(STUB_WORKOS_KEY, { fetch: stubWorkos().fetch });
  const UNKNOWN = 'user_01HUNKNOWN';

  it('service/observability#traces: Users.getBatch gives 1 workos read span for each page of the member list and of the application list, with its kind and status, and no URL', async () => {
    const body = [
      { userId: STUB_PERSON.id },
      { userId: UNKNOWN },
      { userId: 'not-a-workos-id' },
      { userId: SERVICE_USER },
    ];

    await rejecting(
      getUsersBatch(
        { params: {}, query: new URLSearchParams(), body },
        { ...users(), permissions: () => given([]) },
        MEMBER,
      ),
    );

    const spans = recorder.spans();

    expect(shapes(spans)).toEqual([
      {
        name: 'workos read',
        parent: undefined,
        status: SpanStatusCode.UNSET,
        attributes: { 'workos.read': 'members page', 'http.status_code': 200, 'sentry.op': 'http.client' },
      },
      {
        name: 'workos read',
        parent: undefined,
        status: SpanStatusCode.UNSET,
        attributes: { 'workos.read': 'applications page', 'http.status_code': 200, 'sentry.op': 'http.client' },
      },
    ]);

    expect(
      spans.flatMap((span) => Object.values(span.attributes)).filter((value) => String(value).includes('https://')),
    ).toEqual([]);
  });

  it('service/observability#traces: Users.get of an unknown user gives a workos read span of kind user with the status 404', async () => {
    expect(await promised(users().get)(UNKNOWN)).toBeUndefined();

    expect(shapes(recorder.spans())).toEqual([
      {
        name: 'workos read',
        parent: undefined,
        status: SpanStatusCode.UNSET,
        attributes: { 'workos.read': 'user', 'http.status_code': 404, 'sentry.op': 'http.client' },
      },
    ]);
  });

  it('service/observability#traces: the Organizations route gives a workos read span of kind memberships page for each page', async () => {
    await rejecting(listOrganizations({ params: {}, query: new URLSearchParams(), body: undefined }, users(), MEMBER));

    expect(shapes(recorder.spans())).toEqual([
      {
        name: 'workos read',
        parent: undefined,
        status: SpanStatusCode.UNSET,
        attributes: { 'workos.read': 'memberships page', 'http.status_code': 200, 'sentry.op': 'http.client' },
      },
    ]);
  });

  it('service/observability#traces: the permissions of a person give a workos read span of kind membership, then 1 of kind role, and a kept answer gives none', async () => {
    const source = promised(users().permissions);

    await source(PERSON, ORGANIZATION);

    expect(shapes(recorder.spans())).toEqual([
      {
        name: 'workos read',
        parent: undefined,
        status: SpanStatusCode.UNSET,
        attributes: { 'workos.read': 'membership', 'http.status_code': 200, 'sentry.op': 'http.client' },
      },
      {
        name: 'workos read',
        parent: undefined,
        status: SpanStatusCode.UNSET,
        attributes: { 'workos.read': 'role', 'http.status_code': 200, 'sentry.op': 'http.client' },
      },
    ]);

    recorder.reset();

    await source(PERSON, ORGANIZATION);

    expect(recorder.spans()).toEqual([]);
  });

  it('service/observability#traces: a WorkOS answer of 429 ends its workos read span with the status and the error type', async () => {
    answerWorkos(() => new Response('', { status: 429 }));

    const limited = workosUsers(STUB_WORKOS_KEY);

    await expect(promised(limited.get)(STUB_PERSON.id)).rejects.toMatchObject({
      errorName: 'OntologyService:WorkosRateLimited',
    });

    expect(shapes(recorder.spans())).toEqual([
      {
        name: 'workos read',
        parent: undefined,
        status: SpanStatusCode.ERROR,
        attributes: {
          'workos.read': 'user',
          'http.status_code': 429,
          'error.type': 'OntologyService:WorkosRateLimited',
          'sentry.op': 'http.client',
        },
      },
    ]);
  });
});

describe('service/observability#traces: the span of a WorkOS read that the request gives up at its limit', () => {
  it('service/observability#traces: a membership read with no answer ends its workos read span with the time-out before its parent ends', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

    try {
      const stub = stubWorkos();

      stub.fail('timeout');

      const source = promised(workosUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }).permissions);
      const asked = span('token check', {}, () => source(PERSON, ORGANIZATION)).catch((error: unknown) => error);

      await stub.reached(1);

      await vi.advanceTimersByTimeAsync(5000);

      expect(await asked).toMatchObject({ status: 503, errorName: 'OntologyService:WorkosUnavailable' });
    } finally {
      vi.useRealTimers();
    }

    const spans = recorder.spans();
    const read = spans.find((each) => each.name === 'workos read');
    const parent = spans.find((each) => each.name === 'token check');

    expect([
      read?.parentSpanId === parent?.spanId,
      read?.status.code,
      read?.attributes['error.type'],
      read !== undefined && parent !== undefined && read.end <= parent.end,
    ]).toEqual([true, SpanStatusCode.ERROR, 'OntologyService:WorkosUnavailable', true]);
  });

  it('service/observability#traces: 2 role reads at once that never answer, after a fresh kept membership, each end their workos read span with the time-out before their parent ends', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

    try {
      const stub = stubWorkos(
        [STUB_PERSON],
        [
          {
            user_id: STUB_PERSON.id,
            organization_id: ORGANIZATION,
            status: 'active',
            organization_name: 'Test Organization',
            roles: ['r-a', 'r-b'],
          },
        ],
        {
          roles: { [ORGANIZATION]: { 'r-a': ['p-a'], 'r-b': ['p-b'] } },
        },
      );

      const source = promised(workosUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }).permissions);

      stub.fail('5xx', { reads: ['role'] });

      expect(await source(PERSON, ORGANIZATION).catch((error: unknown) => error)).toMatchObject({ status: 503 });

      recorder.reset();

      stub.fail('timeout', { reads: ['role'] });

      const asked = span('token check', {}, () => source(PERSON, ORGANIZATION)).catch((error: unknown) => error);

      await stub.reached(5);

      await vi.advanceTimersByTimeAsync(5000);

      expect(await asked).toMatchObject({ status: 503, errorName: 'OntologyService:WorkosUnavailable' });
    } finally {
      vi.useRealTimers();
    }

    const spans = recorder.spans();
    const parent = spans.find((each) => each.name === 'token check');
    const reads = spans.filter((each) => each.name === 'workos read');

    expect(
      reads.map((read) => [
        read.attributes['workos.read'],
        read.parentSpanId === parent?.spanId,
        read.status.code,
        read.attributes['error.type'],
        parent !== undefined && read.end <= parent.end,
      ]),
    ).toEqual([
      ['role', true, SpanStatusCode.ERROR, 'OntologyService:WorkosUnavailable', true],
      ['role', true, SpanStatusCode.ERROR, 'OntologyService:WorkosUnavailable', true],
    ]);
  });
});
