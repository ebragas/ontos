import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { workosUsers, type UserSource } from './index.ts';
import { WORKOS_API } from './users.ts';
import { handle, handleTrusted, type HandleInput } from '../handler/index.ts';

import {
  ACTIONS_SETTINGS,
  NS,
  ONTOLOGY_RID,
  rowsOf,
  startActions,
  twinFunctions,
  twinIr,
  type ActionsService,
} from '../actions/actions.test-utils.ts';
import { compileOrThrow, grantsOf, stored, unchecked } from '../ontology/stored.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import { emptyDb, TEST_READER, timeLeft, trustedSnapshot } from '../service.test-utils.ts';
import { createTestIssuer, ORGANIZATION, PERSON, type TestIssuer } from '../tokens.test-utils.ts';
import { recordSpans, type SpanRecorder } from '../tracing.test-utils.ts';
import { STUB_PERSON, STUB_WORKOS_KEY, stubPublish } from '../workos.test-utils.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const CREATE_ACCOUNT = `${NS}create-account`;
const ASSIGN_ACCOUNT = `${NS}assign-account`;

const VALIDATE_ONLY = { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' };
const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const PARAMETERS = { accountId: 'acc-assigned', name: 'Assigned', assignee: STUB_PERSON.id };

function testIr(): ReturnType<typeof twinIr> {
  const ir = twinIr('0.6.3');
  const block = structuredClone(ir.ontology.actionTypes[CREATE_ACCOUNT]);

  if (!block) throw new Error('The twin 0.6.3 IR has no create-account.');

  const { metadata, actionTypeLogic } = block.actionType;

  metadata.apiName = ASSIGN_ACCOUNT;

  metadata.parameters['assignee'] = unchecked({
    id: 'assignee',
    type: { type: 'string', string: {} },
    displayMetadata: { displayName: 'assignee', description: '', typeClasses: [] },
  });

  metadata.parameterOrdering.push('assignee');

  actionTypeLogic.validation.parameterValidations['assignee'] = unchecked({
    defaultValidation: {
      display: {
        renderHint: { type: 'userDropdown', userDropdown: {} },
        visibility: { type: 'editable', editable: {} },
      },
      validation: {
        allowedValues: { type: 'user', user: { type: 'user', user: { filter: [] } } },
        required: { type: 'notRequired', notRequired: {} },
      },
    },
    conditionalOverrides: [],
  });

  ir.ontology.actionTypes[ASSIGN_ACCOUNT] = block;

  return ir;
}

const ir = testIr();
const people = roleUsers(grantsOf(ir).defaultRoles);

let service: ActionsService;
let issuer: TestIssuer;
let recorder: SpanRecorder;

const network = setupServer();

beforeAll(async () => {
  network.listen({ onUnhandledFrame: 'error' });

  service = await startActions(ir, twinFunctions('0.6.3'));

  issuer = await createTestIssuer(ACTIONS_SETTINGS.auth);

  recorder = recordSpans();
}, 120_000);

afterEach(() => network.resetHandlers());

afterAll(async () => {
  network.close();

  recorder?.stop();

  await service?.stop();
});

type Answer = (client: AbortController, responseDone: Promise<undefined>) => Response | Promise<Response>;

const otherShape: Answer = () => HttpResponse.json({ data: 'no list' });

const rateLimited =
  (retryAfter: string): Answer =>
  () =>
    HttpResponse.json({ message: 'WorkOS fault' }, { status: 429, headers: { 'retry-after': retryAfter } });

const failed =
  (status: number): Answer =>
  () =>
    HttpResponse.json({ message: 'WorkOS fault' }, { status });

const answersAfterAbort: Answer = (client) => {
  client.abort();

  return HttpResponse.json({ data: [], list_metadata: { after: null } });
};

const answersAfterResponse: Answer = async (client, responseDone) => {
  client.abort();

  await responseDone;

  return HttpResponse.json({ data: [], list_metadata: { after: null } });
};

function reading(): UserSource {
  return { ...people, members: workosUsers(STUB_WORKOS_KEY).members };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const VOLATILE_KEYS = new Set(['errorInstanceId', 'traceId', 'rootSpanId', 'durationMs', 'arrivedAt']);

function stable(fields: Record<string, unknown>): Record<string, unknown> {
  const kept = Object.fromEntries(Object.entries(fields).filter(([key]) => !VOLATILE_KEYS.has(key)));
  const { stack, ...rest } = kept;

  return { ...rest, ...(typeof stack === 'string' ? { stack: stack.split('\n')[0] } : {}) };
}

async function seen(
  send: (input: HandleInput, client: AbortController) => Promise<Response>,
  answer: Answer,
): Promise<unknown> {
  const client = new AbortController();
  const responseDone = Promise.withResolvers<undefined>();

  network.use(
    http.get(`${WORKOS_API}/user_management/organization_memberships`, () => answer(client, responseDone.promise)),
  );

  const faults: unknown[] = [];

  const input: HandleInput = {
    db: fallibleOf(service.db),
    directDb: fallibleOf(service.db),
    settings: ACTIONS_SETTINGS,
    keys: issuer.keys,
    users: reading(),
    workos: stubPublish(),
    reportFault: (error, fields) =>
      void faults.push({ message: error instanceof Error ? error.message : String(error), ...stable({ ...fields }) }),
  };

  recorder.reset();

  const log = vi.spyOn(console, 'log');

  try {
    const response = await send(input, client);

    const headers = Object.fromEntries([...response.headers].filter(([name]) => name !== 'date'));

    const body = (await response.text()).replace(UUID, '<uuid>');

    responseDone.resolve(undefined);

    await vi.waitFor(() => expect(recorder.open()).toEqual([]));

    const lines = log.mock.calls.map(([line]) => stable(JSON.parse(String(line)) as Record<string, unknown>));

    const spans = recorder
      .spans()
      .map(({ name, status, attributes }) => ({ name, status, attributes: stable({ ...attributes }) }));

    const accounts = (await rowsOf(service.db, ACCOUNT, 'account_id')).map((row) => row['account_id']);

    return { status: response.status, headers, body, lines, faults, spans, accounts };
  } finally {
    responseDone.resolve(undefined);

    log.mockRestore();
  }
}

function request(path: string, token: string, body: string, signal?: AbortSignal): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    ...(signal ? { signal } : {}),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body,
  });
}

const APPLY = `/api/v2/ontologies/${ONTOLOGY_RID}/actions/${ASSIGN_ACCOUNT}/apply`;

const apply =
  (options: object) =>
  async (input: HandleInput, client: AbortController): Promise<Response> =>
    handle(
      request(APPLY, await issuer.workos(), JSON.stringify({ parameters: PARAMETERS, options }), client.signal),
      input,
    );

const overMcp = async (input: HandleInput, client: AbortController): Promise<Response> =>
  handle(
    request(
      '/api/mcp',
      await issuer.authkit(),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'apply_action', arguments: { action: ASSIGN_ACCOUNT, parameters: PARAMETERS } },
      }),
      client.signal,
    ),
    input,
  );

const trusted = async (): Promise<Response> =>
  handleTrusted(
    new Request(`http://localhost${APPLY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parameters: PARAMETERS, options: EXECUTE }),
    }),
    {
      db: trustedSnapshot(emptyDb),
      reader: TEST_READER,
      ontology: compileOrThrow(stored(ir, { functions: twinFunctions('0.6.3') })),
      caller: { user: PERSON, kind: 'person', organization: ORGANIZATION, permissions: [] },
      checkWrite: timeLeft,
    },
  );

interface Case {
  readonly name: string;
  readonly run: () => Promise<unknown>;
}

const recorded = (name: string, run: () => Promise<unknown>): Case => ({ name, run });

const STUBS = [
  ['a plain Error', otherShape],
  ['a 503 ApiError with retry-after', rateLimited('7')],
  ['a wait until the client aborts the request', answersAfterResponse],
] as const;

const SENDS = [
  ['apply VALIDATE_AND_EXECUTE', apply(EXECUTE)],
  ['apply VALIDATE_ONLY', apply(VALIDATE_ONLY)],
  ['the MCP tool apply_action', overMcp],
] as const;

const CASES: readonly Case[] = [
  ...STUBS.flatMap(([stub, answer]) =>
    SENDS.filter(([route]) => !(answer === answersAfterResponse && route === 'the MCP tool apply_action')).map(
      ([route, send]) => recorded(`${route}: the member check gets ${stub}`, () => seen(send, answer)),
    ),
  ),
  recorded('apply VALIDATE_AND_EXECUTE: WorkOS answers the member list read with 429 and retry-after', () =>
    seen(apply(EXECUTE), rateLimited('3')),
  ),
  recorded('apply VALIDATE_AND_EXECUTE: WorkOS answers the member list read with 500', () =>
    seen(apply(EXECUTE), failed(500)),
  ),
  recorded('apply VALIDATE_AND_EXECUTE: WorkOS answers the member list read with 401', () =>
    seen(apply(EXECUTE), failed(401)),
  ),
  recorded('handleTrusted: an apply never reaches the member check', () => seen(trusted, otherShape)),
];

describe('a WorkOS fault in the member check of an apply', () => {
  for (const { name, run } of CASES) {
    it(name, async () => {
      expect(await run()).toMatchSnapshot();
    });
  }

  it('the MCP tool apply_action: the client aborts during the member list read and WorkOS then answers, so the call answers 200 with the result INVALID and no fault', async () => {
    const answer = (await seen(overMcp, answersAfterAbort)) as { status: number; body: string; faults: unknown[] };

    expect(answer.status).toBe(200);
    expect(answer.faults).toEqual([]);

    expect(JSON.parse(answer.body)).toMatchObject({
      result: { structuredContent: { validation: { result: 'INVALID' } } },
    });

    expect(answer).toMatchSnapshot();
  });
});
