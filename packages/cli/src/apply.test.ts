import { describe, expect, it } from 'vitest';
import {
  cli,
  stubExchange,
  replay,
  STUB,
  STUB_CONFIG,
  stubConfig,
  stubFetch,
  withRequest,
  type Exchange,
  type Handler,
} from './cli.test-utils.ts';

const ACCOUNT = 'com.example.twin.Account';
const ENGAGEMENT = 'com.example.twin.Engagement';
const flags = ['--app', 'twin', '--url', STUB];
const env = { ONTOLOGY_TOKEN: 't' };

const run = (args: readonly string[], ...handlers: Handler[]) =>
  cli([...args, ...flags], { fetch: stubFetch(stubConfig, ...handlers), env });

describe('ontology apply', () => {
  it('service/cli#commands: apply applies 1 Action, with --parameters as JSON in the OSDK form', async () => {
    const result = await run(
      [
        'apply',
        'com.example.twin.create-engagement',
        '--parameters',
        '{"engagementId":"eng-7","accountId":"acc-2","title":"Expansion","amount":22000}',
      ],
      replay(stubExchange('client', 14), stubExchange('client', 15)),
    );

    expect(result.error).toBeUndefined();
    expect(result.code).toBe(0);

    expect(result.output).toEqual({
      type: 'edits',
      deletedLinksCount: 0,
      deletedObjectsCount: 0,
      addedLinks: [],
      deletedLinks: [],
      addedObjects: [{ objectType: ENGAGEMENT, primaryKey: 'eng-7' }],
      deletedObjects: [],
      modifiedObjects: [],
      editedObjectTypes: [ENGAGEMENT],
    });
  });

  it('service/cli#commands: an Object parameter is its primary key', async () => {
    const result = await run(
      [
        'apply',
        'com.example.twin.set-engagement-status',
        '--parameters',
        '{"objectToModifyParameter":"eng-7","status":"won"}',
      ],
      replay(stubExchange('client', 17), stubExchange('client', 18)),
    );

    expect(result.error).toBeUndefined();
    expect(result.code).toBe(0);

    expect((result.output as { modifiedObjects: unknown }).modifiedObjects).toEqual([
      { objectType: ENGAGEMENT, primaryKey: 'eng-7' },
    ]);
  });

  it('service/cli#commands: --validate-only sends VALIDATE_ONLY, and prints the validation', async () => {
    const result = await run(
      ['apply', 'com.example.twin.create-engagement', '--parameters', '{"title":"Validate only"}', '--validate-only'],
      replay(stubExchange('client', 14), stubExchange('client', 24)),
    );

    expect(result.error).toBeUndefined();
    expect(result.code).toBe(0);

    expect(result.output).toEqual({
      result: 'VALID',
      submissionCriteria: [],
      parameters: {
        accountId: { result: 'VALID', evaluatedConstraints: [], required: false },
        amount: { result: 'VALID', evaluatedConstraints: [], required: false },
        title: { result: 'VALID', evaluatedConstraints: [], required: true },
        engagementId: { result: 'VALID', evaluatedConstraints: [], required: false },
      },
    });
  });

  it('service/cli#commands: an apply that the service refuses prints its error body and exits with 1', async () => {
    const duplicate = stubExchange('client', 21);

    const asked = withRequest(duplicate, {
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
    });

    const result = await run(
      ['apply', 'com.example.twin.create-engagement', '--parameters', '{"engagementId":"eng-1","title":"Duplicate"}'],
      replay(stubExchange('client', 14), asked),
    );

    expect(result.code).toBe(1);

    expect(result.error).toEqual({
      errorCode: 'CONFLICT',
      errorName: 'ObjectAlreadyExists',
      errorInstanceId: 'd7c26299-1870-4db0-bf9a-0fb82ddf5421',
      parameters: {},
    });
  });
});

describe('ontology history', () => {
  const PERSON = 'user_01TEST00000000000000000001';
  const CI = 'repo:example/twin:environment:publish';

  const entry = (userId: string) => ({
    objectPrimaryKey: { accountId: { type: 'stringValue', value: 'acc-1' } },
    operationId: 'ri.actions.main.action.00000000-0000-0000-0000-000000000001',
    actionTypeRid: 'ri.actions.main.action-type.3e8e2b9b-b994-47cf-ac97-7d036c81067d',
    userId,
    timestamp: '2026-10-25T12:00:00Z',
    edit: { type: 'createEdit', properties: { accountId: 'acc-1', name: 'Acme' } },
  });

  const history = (requestBody: unknown, userIds: readonly string[] = [PERSON]): Exchange => ({
    method: 'POST',
    path: `/api/v2/ontologies/${STUB_CONFIG.productRid}/objectTypes/${ACCOUNT}/editsHistory`,
    requestBody,
    status: 200,
    responseBody: { data: userIds.map(entry), totalCount: userIds.length },
  });

  const ada = {
    id: PERSON,
    username: 'ada@example.com',
    email: 'ada@example.com',
    givenName: 'Ada',
    familyName: 'Lovelace',
    realm: 'workos',
    status: 'ACTIVE',
    attributes: {},
  };

  const FORMER = 'user_01FORMER00000000000000000';

  const grace = {
    id: FORMER,
    username: 'grace@example.com',
    email: 'grace@example.com',
    givenName: 'Grace',
    familyName: 'Hopper',
    realm: 'workos',
    status: 'DELETED',
    attributes: {},
  };

  const getBatch = (status: 'ACTIVE' | 'DELETED', userIds: readonly string[], users: readonly object[]): Exchange => ({
    method: 'POST',
    path: '/api/v2/admin/users/getBatch',
    requestBody: userIds.map((userId) => ({ userId, status })),
    status: 200,
    responseBody: { data: Object.fromEntries(users.map((user) => [(user as { id: string }).id, user])) },
  });

  it('service/cli#commands, ontology/object-edits/edit-history#reading: history reads the Object Edit History of 1 Object through editsHistory, with @osdk/foundry.ontologies', async () => {
    const fetch = stubFetch(
      stubConfig,
      replay(
        stubExchange('client', 1),
        history({ objectPrimaryKey: { accountId: { type: 'stringValue', value: 'acc-1' } } }),
        getBatch('ACTIVE', [PERSON], [ada]),
      ),
    );

    const result = await cli(['history', ACCOUNT, 'acc-1', ...flags], { fetch, env });

    expect(result.error).toBeUndefined();
    expect(result.code).toBe(0);

    expect(result.output).toEqual({
      data: [{ ...entry(PERSON), user: { name: 'Ada Lovelace', email: 'ada@example.com' } }],
      totalCount: 1,
    });

    expect(fetch.calls.at(-1)?.headers['authorization']).toBe('Bearer t');
  });

  it('service/cli#commands: history with no primary key reads the entries of all Objects of the type', async () => {
    const result = await run(['history', ACCOUNT], replay(history({}), getBatch('ACTIVE', [PERSON], [ada])));

    expect(result.error).toBeUndefined();
    expect((result.output as { data: unknown[] }).data).toHaveLength(1);
  });

  const batchBodies = (calls: readonly { readonly url: string; readonly body?: string | undefined }[]) =>
    calls
      .filter((call) => call.url.endsWith('/api/v2/admin/users/getBatch'))
      .map((call) => JSON.parse(call.body ?? '') as unknown);

  it("service/cli#commands: history adds user to the person's entry and none to the CI entry, and asks for the DELETED status only of the CI subject", async () => {
    const fetch = stubFetch(
      stubConfig,
      replay(history({}, [PERSON, CI, PERSON]), getBatch('ACTIVE', [PERSON, CI], [ada]), getBatch('DELETED', [CI], [])),
    );

    const result = await cli(['history', ACCOUNT, ...flags], { fetch, env });

    expect(result.error).toBeUndefined();

    const user = { name: 'Ada Lovelace', email: 'ada@example.com' };

    expect(result.output).toEqual({
      data: [{ ...entry(PERSON), user }, entry(CI), { ...entry(PERSON), user }],
      totalCount: 3,
    });

    expect(batchBodies(fetch.calls)).toEqual([
      [
        { userId: PERSON, status: 'ACTIVE' },
        { userId: CI, status: 'ACTIVE' },
      ],
      [{ userId: CI, status: 'DELETED' }],
    ]);
  });

  it('service/cli#commands: history names an active editor and a former editor, with 2 Users.getBatch calls for the page', async () => {
    const fetch = stubFetch(
      stubConfig,
      replay(
        history({}, [PERSON, FORMER]),
        getBatch('ACTIVE', [PERSON, FORMER], [ada]),
        getBatch('DELETED', [FORMER], [grace]),
      ),
    );

    const result = await cli(['history', ACCOUNT, ...flags], { fetch, env });

    expect(result.error).toBeUndefined();

    expect(result.output).toEqual({
      data: [
        { ...entry(PERSON), user: { name: 'Ada Lovelace', email: 'ada@example.com' } },
        { ...entry(FORMER), user: { name: 'Grace Hopper', email: 'grace@example.com' } },
      ],
      totalCount: 2,
    });

    expect(batchBodies(fetch.calls)).toEqual([
      [
        { userId: 'user_01TEST00000000000000000001', status: 'ACTIVE' },
        { userId: 'user_01FORMER00000000000000000', status: 'ACTIVE' },
      ],
      [{ userId: 'user_01FORMER00000000000000000', status: 'DELETED' }],
    ]);
  });

  it('service/cli#commands: history makes no 2nd Users.getBatch call when each ID is active', async () => {
    const fetch = stubFetch(stubConfig, replay(history({}, [PERSON, PERSON]), getBatch('ACTIVE', [PERSON], [ada])));

    const result = await cli(['history', ACCOUNT, ...flags], { fetch, env });

    expect(result.error).toBeUndefined();
    expect(batchBodies(fetch.calls)).toEqual([[{ userId: PERSON, status: 'ACTIVE' }]]);
  });

  it('service/cli#commands: the name of a user with no given name and no family name is the email', async () => {
    const bare = {
      id: PERSON,
      username: 'ci+twin@example.com',
      email: 'ci+twin@example.com',
      realm: 'workos',
      status: 'ACTIVE',
      attributes: {},
    };

    const result = await run(['history', ACCOUNT], replay(history({}), getBatch('ACTIVE', [PERSON], [bare])));

    expect((result.output as { data: { user: unknown }[] }).data[0]?.user).toEqual({
      name: 'ci+twin@example.com',
      email: 'ci+twin@example.com',
    });
  });

  const failing = (status: 'ACTIVE' | 'DELETED', userIds: readonly string[]): Exchange => ({
    ...getBatch(status, userIds, []),
    status: 500,
    responseBody: {
      errorCode: 'INTERNAL',
      errorName: 'Default:Internal',
      errorInstanceId: '00000000-0000-0000-0000-000000000002',
      parameters: {},
    },
  });

  it.each([
    ['the ACTIVE call', [failing('ACTIVE', [PERSON, FORMER])]],
    ['the DELETED call', [getBatch('ACTIVE', [PERSON, FORMER], [ada]), failing('DELETED', [FORMER])]],
  ])(
    'service/cli#commands: history prints each entry with userId and no user, writes 1 warning, and exits 0 when %s fails',
    async (_, batches) => {
      const result = await run(['history', ACCOUNT], replay(history({}, [PERSON, FORMER, PERSON]), ...batches));

      expect(result.code).toBe(0);
      expect(result.output).toEqual({ data: [entry(PERSON), entry(FORMER), entry(PERSON)], totalCount: 3 });

      const lines = result.stderr.trim().split('\n');

      expect(lines).toHaveLength(1);

      expect(JSON.parse(lines[0] ?? '')).toEqual({
        warning: 'Could not read the names of the users: Default:Internal',
      });
    },
  );

  it('service/cli#commands: the warning gives the message of the error when the answer has no errorName', async () => {
    const result = await run(
      ['history', ACCOUNT],
      replay(history({}, [PERSON]), {
        ...failing('ACTIVE', [PERSON]),
        status: 502,
        responseBody: { message: 'Bad gateway' },
      }),
    );

    expect(result.code).toBe(0);
    expect(result.output).toEqual({ data: [entry(PERSON)], totalCount: 1 });
    expect(result.stderr).toBe('{"warning":"Could not read the names of the users: Bad gateway"}\n');
  });

  it('an empty page needs no Users.getBatch call', async () => {
    const fetch = stubFetch(stubConfig, replay(history({}, [])));

    const result = await cli(['history', ACCOUNT, ...flags], { fetch, env });

    expect(result.output).toEqual({ data: [], totalCount: 0 });
    expect(fetch.calls.filter((call) => call.url.includes('/admin/'))).toEqual([]);
  });
});
