import { beforeEach, describe, expect, it } from 'vitest';
import { resetAccessTokens } from './auth/provider.ts';
import { run } from './index.ts';
import { resetMetadata, metadataFetch } from './metadataCache.ts';
import { notesApp } from './apps.test-utils.ts';
import {
  stubExchange,
  stubMetadata,
  replay,
  STUB,
  STUB_CONFIG,
  stubConfig,
  stubFetch,
  tempFolder,
  type Call,
  type Handler,
} from './cli.test-utils.ts';

const RID = STUB_CONFIG.productRid;
const ACCOUNT = 'com.example.twin.Account';
const OBJECTS = ['objects', ACCOUNT, '--page-size', '2', '--order-by', '{"name":"asc"}'];
const AT_STUB = ['--app', 'twin', '--url', STUB];

beforeEach(() => {
  resetMetadata();

  resetAccessTokens();
});

const anyHost =
  (handler: Handler): Handler =>
  (call) => {
    const { pathname, search } = new URL(call.url);

    return handler({ ...call, url: `${STUB}${pathname}${search}` });
  };

const fullMetadata: Handler = ({ method, url }) =>
  method === 'GET' && new URL(url).pathname === `/api/v2/ontologies/${RID}/fullMetadata`
    ? Response.json(stubMetadata())
    : undefined;

const editsHistory: Handler = ({ method, url }) =>
  method === 'POST' && new URL(url).pathname === `/api/v2/ontologies/${RID}/objectTypes/${ACCOUNT}/editsHistory`
    ? Response.json({ data: [], totalCount: 0 })
    : undefined;

const publishRoute: Handler = ({ method, url }) =>
  method === 'POST' && url === `${STUB}/api/ontology-service/v1/publish`
    ? Response.json({ changes: [], metadata: { ontology: { rid: RID } }, version: 1 })
    : undefined;

const installRoute: Handler = ({ method, url }) =>
  method === 'POST' && url === `${STUB}/api/ontology-service/v1/ontologies`
    ? Response.json({
        rid: 'ri.ontology.main.ontology.6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7',
        apiName: 'acme',
        displayName: 'Acme',
        description: '',
      })
    : undefined;

const twinFetch = (...handlers: Handler[]) =>
  stubFetch(
    ...handlers,
    anyHost(stubConfig),
    anyHost(
      replay(
        stubExchange('client', 1),
        stubExchange('client', 2),
        stubExchange('client', 11),
        stubExchange('client', 14),
        stubExchange('client', 15),
      ),
    ),
    fullMetadata,
    editsHistory,
    publishRoute,
    installRoute,
  );

const lists = (calls: readonly Call[]) =>
  calls
    .filter(({ method, url }) => method === 'GET' && url === `${STUB}/api/v2/ontologies`)
    .map(({ headers }) => headers['authorization']);

async function ontology(
  args: readonly string[],
  fetch: typeof globalThis.fetch,
  cwd = tempFolder(),
  token = 't',
): Promise<{ code: number; stderr: string }> {
  let stderr = '';

  const code = await run(args, {
    cwd,
    env: { ONTOLOGY_TOKEN: token, XDG_CONFIG_HOME: tempFolder() },
    fetch,
    sleep: () => Promise.resolve(),
    stdout: () => undefined,
    stderr: (text) => (stderr += text),
  });

  return { code, stderr };
}

function tally(calls: readonly Call[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const { method, url } of calls) {
    const { host, pathname } = new URL(url);
    const route = `${method} ${host} ${pathname.replace(`/api/v2/ontologies/${RID}/`, '')}`;

    counts[route] = (counts[route] ?? 0) + 1;
  }

  return counts;
}

const STUB_HOST = new URL(STUB).host;

describe('the kept metadata of 1 process', () => {
  it('service/cli#package: later commands use the kept client-config and metadata, and each loadObjects, aggregate, apply, and editsHistory goes to the service', async () => {
    const fetch = twinFetch();

    const apply = [
      'apply',
      'com.example.twin.create-engagement',
      '--parameters',
      '{"engagementId":"eng-7","accountId":"acc-2","title":"Expansion","amount":22000}',
    ];

    const aggregate = [
      'aggregate',
      'com.example.twin.Engagement',
      '--select',
      '{"$count":"unordered","amount:sum":"unordered","amount:max":"unordered"}',
      '--group-by',
      '{"status":"exact"}',
    ];

    for (const args of [
      OBJECTS,
      OBJECTS,
      ['describe'],
      apply,
      apply,
      aggregate,
      aggregate,
      ['history', ACCOUNT],
      ['history', ACCOUNT],
    ]) {
      expect(await ontology([...args, ...AT_STUB], fetch)).toEqual({ code: 0, stderr: '' });
    }

    expect(tally(fetch.calls)).toEqual({
      [`GET ${STUB_HOST} /api/ontology-service/v1/client-config`]: 1,
      [`GET ${STUB_HOST} /api/v2/ontologies`]: 1,
      [`GET ${STUB_HOST} objectTypes/${ACCOUNT}/fullMetadata`]: 1,
      [`GET ${STUB_HOST} fullMetadata`]: 1,
      [`GET ${STUB_HOST} actionTypes/com.example.twin.create-engagement`]: 1,
      [`POST ${STUB_HOST} objectSets/loadObjects`]: 2,
      [`POST ${STUB_HOST} actions/com.example.twin.create-engagement/apply`]: 2,
      [`POST ${STUB_HOST} objectSets/aggregate`]: 2,
      [`POST ${STUB_HOST} objectTypes/${ACCOUNT}/editsHistory`]: 2,
    });
  });

  it('service/cli#package: 2 apps in 1 process never share an answer, so each gets its own client-config', async () => {
    const fetch = twinFetch();

    for (const app of ['twin', 'other', 'twin', 'other'])
      expect(await ontology([...OBJECTS, '--app', app], fetch)).toEqual({ code: 0, stderr: '' });

    expect(tally(fetch.calls)).toEqual({
      'GET twin-staging.ontos.example /api/ontology-service/v1/client-config': 1,
      'GET twin-staging.ontos.example /api/v2/ontologies': 1,
      [`GET twin-staging.ontos.example objectTypes/${ACCOUNT}/fullMetadata`]: 1,
      'POST twin-staging.ontos.example objectSets/loadObjects': 2,
      'GET other-staging.ontos.example /api/ontology-service/v1/client-config': 1,
      'GET other-staging.ontos.example /api/v2/ontologies': 1,
      [`GET other-staging.ontos.example objectTypes/${ACCOUNT}/fullMetadata`]: 1,
      'POST other-staging.ontos.example objectSets/loadObjects': 2,
    });
  });

  it('service/cli#package: the kept Ontology list is for 1 token, and each host keeps the list of its latest token only', async () => {
    const fetch = twinFetch();

    for (const token of ['t1', 't1', 't2', 't2', 't1'])
      expect(await ontology([...OBJECTS, ...AT_STUB], fetch, tempFolder(), token)).toEqual({ code: 0, stderr: '' });

    expect(lists(fetch.calls)).toEqual(['Bearer t1', 'Bearer t2', 'Bearer t1']);
  });

  it('service/cli#package: a failed Ontology list is not kept, so the next command asks again', async () => {
    let failures = 1;

    const failing: Handler = ({ url }) =>
      url === `${STUB}/api/v2/ontologies` && failures-- > 0
        ? Response.json({ message: 'failing' }, { status: 500 })
        : undefined;

    const fetch = twinFetch(failing);

    expect((await ontology([...OBJECTS, ...AT_STUB], fetch)).code).toBe(1);

    expect(await ontology([...OBJECTS, ...AT_STUB], fetch)).toEqual({ code: 0, stderr: '' });

    expect(await ontology([...OBJECTS, ...AT_STUB], fetch)).toEqual({ code: 0, stderr: '' });

    expect(lists(fetch.calls)).toHaveLength(2);
  });

  it('service/cli#package: an answer other than 200 is not kept, so the next command asks again', async () => {
    let failures = 1;

    const failing: Handler = ({ url }) =>
      url.endsWith('/client-config') && failures-- > 0
        ? Response.json({ message: 'failing' }, { status: 500 })
        : undefined;

    const fetch = twinFetch(failing);

    const failed = await ontology([...OBJECTS, ...AT_STUB], fetch);

    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stderr)).toMatchObject({ message: 'failing' });

    expect(await ontology([...OBJECTS, ...AT_STUB], fetch)).toEqual({ code: 0, stderr: '' });

    expect(await ontology([...OBJECTS, ...AT_STUB], fetch)).toEqual({ code: 0, stderr: '' });

    expect(tally(fetch.calls)[`GET ${STUB_HOST} /api/ontology-service/v1/client-config`]).toBe(2);
  });

  it('service/cli#package: a read that the CLI tries again after a 503 keeps only its final 200', async () => {
    let failures = 1;

    const unavailable: Handler = ({ url }) =>
      url.endsWith('/client-config') && failures-- > 0
        ? Response.json({ message: 'unavailable' }, { status: 503 })
        : undefined;

    const fetch = twinFetch(unavailable);

    for (let command = 1; command <= 3; command += 1)
      expect(await ontology([...OBJECTS, ...AT_STUB], fetch)).toEqual({ code: 0, stderr: '' });

    expect(tally(fetch.calls)[`GET ${STUB_HOST} /api/ontology-service/v1/client-config`]).toBe(2);
  });

  it('service/cli#package: after a validate, the next command reads the client-config and the metadata of its target again', async () => {
    const fetch = twinFetch();

    expect(await ontology([...OBJECTS, ...AT_STUB], fetch)).toEqual({ code: 0, stderr: '' });

    expect(await ontology(['validate', ...AT_STUB], fetch, notesApp())).toEqual({ code: 0, stderr: '' });

    expect(await ontology([...OBJECTS, ...AT_STUB], fetch)).toEqual({ code: 0, stderr: '' });

    const routes = fetch.calls.map(
      ({ method, url }) => `${method} ${new URL(url).pathname.replace(`/api/v2/ontologies/${RID}/`, '')}`,
    );

    const metadata = ['GET /api/ontology-service/v1/client-config', `GET objectTypes/${ACCOUNT}/fullMetadata`];
    const publish = routes.indexOf('POST /api/ontology-service/v1/publish');

    expect(routes.slice(0, publish).filter((route) => metadata.includes(route))).toEqual(metadata);
    expect(routes.slice(publish + 1).filter((route) => metadata.includes(route))).toEqual(metadata);
  });

  it('service/cli#package: after an install, the next command reads the Ontology list of its target again', async () => {
    const fetch = twinFetch();

    expect(await ontology([...OBJECTS, ...AT_STUB], fetch)).toEqual({ code: 0, stderr: '' });

    expect(
      (await ontology(['install', 'twin', '--api-name', 'acme', '--display-name', 'Acme', ...AT_STUB], fetch)).code,
    ).toBe(0);

    expect(await ontology([...OBJECTS, ...AT_STUB], fetch)).toEqual({ code: 0, stderr: '' });

    expect(lists(fetch.calls)).toHaveLength(2);
  });

  it('service/cli#package: a validate that fails drops the kept answers of its target, and keeps those of another target', async () => {
    const fetch = twinFetch();

    expect(await ontology([...OBJECTS, ...AT_STUB], fetch)).toEqual({ code: 0, stderr: '' });

    expect(await ontology([...OBJECTS, '--app', 'twin'], fetch)).toEqual({ code: 0, stderr: '' });

    expect((await ontology(['validate', ...AT_STUB], fetch)).code).toBe(1);

    expect(await ontology([...OBJECTS, ...AT_STUB], fetch)).toEqual({ code: 0, stderr: '' });

    expect(await ontology([...OBJECTS, '--app', 'twin'], fetch)).toEqual({ code: 0, stderr: '' });

    const counts = tally(fetch.calls);

    expect(counts[`GET ${STUB_HOST} /api/ontology-service/v1/client-config`]).toBe(2);
    expect(counts[`GET ${STUB_HOST} objectTypes/${ACCOUNT}/fullMetadata`]).toBe(2);
    expect(counts[`GET ${STUB_HOST} /api/v2/ontologies`]).toBe(2);
    expect(counts['GET twin-staging.ontos.example /api/ontology-service/v1/client-config']).toBe(1);
    expect(counts[`GET twin-staging.ontos.example objectTypes/${ACCOUNT}/fullMetadata`]).toBe(1);
    expect(counts['GET twin-staging.ontos.example /api/v2/ontologies']).toBe(1);
  });

  it('scopes cached metadata by authorization token so two callers do not share permission-filtered responses', async () => {
    const fetch = stubFetch(({ method, url, headers }) => {
      if (method === 'GET' && url === `${STUB}/api/v2/ontologies/${RID}/fullMetadata`)
        return Response.json({ seenToken: headers['authorization'] ?? 'none' });

      return undefined;
    });

    const cached = metadataFetch(fetch);
    const url = `${STUB}/api/v2/ontologies/${RID}/fullMetadata`;

    const firstA = await (await cached(url, { headers: { authorization: 'Bearer token-alpha' } })).json();

    const firstB = await (await cached(url, { headers: { authorization: 'Bearer token-beta' } })).json();

    const secondA = await (await cached(url, { headers: { authorization: 'Bearer token-alpha' } })).json();

    const secondB = await (await cached(url, { headers: { authorization: 'Bearer token-beta' } })).json();

    expect(firstA).toEqual({ seenToken: 'Bearer token-alpha' });
    expect(firstB).toEqual({ seenToken: 'Bearer token-beta' });
    expect(secondA).toEqual({ seenToken: 'Bearer token-alpha' });
    expect(secondB).toEqual({ seenToken: 'Bearer token-beta' });
    expect(fetch.calls).toHaveLength(2);
  });

  it('evicts the least-recently-used metadata entry once the cache exceeds 64 entries', async () => {
    const fetch = stubFetch(({ method, url }) => {
      if (method === 'GET') return Response.json({ url });

      return undefined;
    });

    const cached = metadataFetch(fetch);
    const urlFor = (index: number) => `${STUB}/api/v2/ontologies/${RID}/objectTypes/Type${index}/fullMetadata`;

    for (let index = 0; index < 64; index += 1) await cached(urlFor(index), { headers: { authorization: 'Bearer t' } });

    await cached(urlFor(0), { headers: { authorization: 'Bearer t' } });

    await cached(urlFor(64), { headers: { authorization: 'Bearer t' } });

    const beforeRecheck = fetch.calls.length;

    await cached(urlFor(0), { headers: { authorization: 'Bearer t' } });

    expect(fetch.calls).toHaveLength(beforeRecheck);

    await cached(urlFor(1), { headers: { authorization: 'Bearer t' } });

    expect(fetch.calls).toHaveLength(beforeRecheck + 1);
  });
});
