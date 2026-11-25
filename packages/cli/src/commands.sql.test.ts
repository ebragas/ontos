import { beforeAll, describe, expect, it } from 'vitest';
import { twinFunctionsApp, twinOntology } from './apps.test-utils.ts';
import { cli, stubFetch, tempFolder, withoutDescriptionWarnings } from './cli.test-utils.ts';
import { localGate, installGate, personEnv, toLocal } from './sql.test-utils.ts';

const local = localGate();
const ACCOUNT = 'com.example.twin.Account';
const ENGAGEMENT = 'com.example.twin.Engagement';
const CREATE_ACCOUNT = 'com.example.twin.create-account';
const SET_STATUS = 'com.example.twin.set-engagement-status';

const WITH_DESCRIPTIONS = twinOntology('0.7.0')
  .replace(
    "  pluralDisplayName: 'Accounts',\n",
    '  pluralDisplayName: \'Accounts\',\n  description: "A customer or a prospect.",\n',
  )
  .replace(
    "    phase: { type: 'string' },\n",
    '    phase: { type: \'string\', description: "prospect, customer, or closed" },\n',
  )
  .replace(
    "defineCreateObjectAction({ objectType: account, apiName: 'create-account' });",
    'defineCreateObjectAction({ objectType: account, apiName: \'create-account\', description: "Creates 1 Account." });',
  );

const run = async (args: readonly string[]) =>
  cli([...args, ...local.flags()], { cwd: tempFolder(), fetch: globalThis.fetch, env: await personEnv(local.service) });

function osdk(
  type: string,
  primaryKey: string,
  title: string | undefined,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...properties,
    $apiName: type,
    $objectType: type,
    $primaryKey: primaryKey,
    ...(title !== undefined ? { $title: title } : {}),
    $objectSpecifier: `${type}:${primaryKey}`,
  };
}

const ACCOUNTS = [
  { accountId: 'acc-1', name: 'Acme', phase: 'customer' },
  { accountId: 'acc-2', name: 'Globex', phase: 'prospect' },
  { accountId: 'acc-3', name: 'Initech', phase: 'customer' },
];

const [ACME, GLOBEX, INITECH] = ACCOUNTS.map((account) => osdk(ACCOUNT, account.accountId, account.name, account));

const ENGAGEMENTS = [
  { engagementId: 'eng-1', accountId: 'acc-1', title: 'Discovery workshop', amount: 12000 },
  { engagementId: 'eng-2', accountId: 'acc-1', title: 'Rollout', amount: 48000 },
  { engagementId: 'eng-3', accountId: 'acc-2', title: 'Pilot', amount: 15000 },
];

beforeAll(async () => {
  expect(WITH_DESCRIPTIONS.match(/description: "/g)).toHaveLength(3);

  const published = await cli(['publish', ...local.flags()], {
    cwd: twinFunctionsApp({ 'ontology/src/ontology.mts': WITH_DESCRIPTIONS }),
    fetch: stubFetch(toLocal),
    env: local.service.oidcEnv,
  });

  expect(withoutDescriptionWarnings(published.stderr)).toBe('');

  await installGate(local.service);

  for (const parameters of ACCOUNTS)
    expect((await run(['apply', CREATE_ACCOUNT, '--parameters', JSON.stringify(parameters)])).stderr).toBe('');

  for (const parameters of ENGAGEMENTS)
    expect(
      (await run(['apply', 'com.example.twin.create-engagement', '--parameters', JSON.stringify(parameters)])).stderr,
    ).toBe('');
});

describe('describe against node.ts', () => {
  it("service/cli#commands, service/cli#package: describe lists the types, and shows the description of each Object Type, Property, and Action Type, a Link Type's display name, target, cardinality, and RID, and a Link Type by its API name, with no Ontology SDK", async () => {
    const list = await run(['describe']);

    expect(list.stderr).toBe('');
    expect(list.code).toBe(0);

    const listed = list.output as { objectTypes: unknown[]; linkTypes: unknown[]; actionTypes: unknown[] };

    expect(listed.objectTypes).toEqual([
      { apiName: ACCOUNT, displayName: 'Account', description: 'A customer or a prospect.' },
      { apiName: ENGAGEMENT, displayName: 'Engagement' },
      { apiName: 'com.example.twin.StructProbe', displayName: 'Struct Probe' },
    ]);

    const linkRid = (listed.linkTypes[0] as { linkTypeRid: string }).linkTypeRid;

    expect(linkRid).toMatch(/^ri\.ontology\.main\.relation\./);

    expect(listed.linkTypes).toEqual([
      {
        objectType: ACCOUNT,
        apiName: 'engagements',
        displayName: 'Engagement',
        target: ENGAGEMENT,
        cardinality: 'MANY',
        linkTypeRid: linkRid,
      },
      {
        objectType: ENGAGEMENT,
        apiName: 'account',
        displayName: 'Account',
        target: ACCOUNT,
        cardinality: 'ONE',
        linkTypeRid: linkRid,
      },
    ]);

    expect(listed.actionTypes).toContainEqual({
      apiName: CREATE_ACCOUNT,
      displayName: 'Create Account',
      description: 'Creates 1 Account.',
    });

    const account = await run(['describe', ACCOUNT]);

    expect(account.code).toBe(0);

    const shown = (account.output as { objectType: { description: string; properties: Record<string, unknown> } })
      .objectType;

    expect(shown.description).toBe('A customer or a prospect.');

    expect(shown.properties['phase']).toEqual({
      displayName: 'Phase',
      description: 'prospect, customer, or closed',
      dataType: { type: 'string' },
    });

    const action = await run(['describe', CREATE_ACCOUNT]);

    expect(action.code).toBe(0);

    expect((action.output as { actionType: { description: string } }).actionType.description).toBe(
      'Creates 1 Account.',
    );

    const link = await run(['describe', 'account']);

    expect(link.code).toBe(0);

    expect(link.output).toEqual({
      linkTypes: [
        {
          objectType: ENGAGEMENT,
          apiName: 'account',
          displayName: 'Account',
          target: ACCOUNT,
          cardinality: 'ONE',
          linkTypeRid: linkRid,
        },
      ],
    });

    const linkType = await run(['describe', 'accountToEngagements']);

    expect(linkType.code).toBe(0);

    expect(linkType.output).toEqual({
      linkType: { apiName: 'accountToEngagements', rid: linkRid, sides: listed.linkTypes },
    });
  });
});

describe('objects against node.ts', () => {
  it('service/cli#commands, service/cli#package, service/cli#output: objects loads the Objects with the stock client, which knows the Object Type only by its API name, and prints 1 JSON value on stdout', async () => {
    const result = await run(['objects', ACCOUNT, '--order-by', '{"name":"asc"}']);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.output).toEqual({ data: [ACME, GLOBEX, INITECH], totalCount: '3' });
  });

  it('service/cli#commands: objects <ObjectType> <primary key> loads 1 Object, and --link loads the Objects of 1 Link of the Object', async () => {
    const one = await run(['objects', ACCOUNT, 'acc-2']);

    expect(one.stderr).toBe('');
    expect(one.code).toBe(0);
    expect(one.output).toEqual(GLOBEX);

    const many = await run([
      'objects',
      ACCOUNT,
      'acc-1',
      '--link',
      'engagements',
      '--order-by',
      '{"amount":"asc"}',
      '--select',
      '["title","amount"]',
    ]);

    expect(many.stderr).toBe('');
    expect(many.code).toBe(0);

    expect(many.output).toEqual({
      data: [
        osdk(ENGAGEMENT, 'eng-1', 'Discovery workshop', {
          engagementId: 'eng-1',
          title: 'Discovery workshop',
          amount: 12000,
        }),
        osdk(ENGAGEMENT, 'eng-2', 'Rollout', { engagementId: 'eng-2', title: 'Rollout', amount: 48000 }),
      ],
      totalCount: '2',
    });

    const owner = await run(['objects', ENGAGEMENT, 'eng-3', '--link', 'account']);

    expect(owner.code).toBe(0);
    expect(owner.output).toEqual({ data: [GLOBEX], totalCount: '1' });
  });

  it('service/cli#commands: objects takes --where in the OSDK syntax as JSON, --order-by, and --select, and aggregate takes --where', async () => {
    const result = await run([
      'objects',
      ENGAGEMENT,
      '--where',
      '{"amount":{"$gte":13000}}',
      '--order-by',
      '{"amount":"desc"}',
      '--select',
      '["title"]',
    ]);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);

    expect(result.output).toEqual({
      data: [
        osdk(ENGAGEMENT, 'eng-2', 'Rollout', { engagementId: 'eng-2', title: 'Rollout' }),
        osdk(ENGAGEMENT, 'eng-3', 'Pilot', { engagementId: 'eng-3', title: 'Pilot' }),
      ],
      totalCount: '2',
    });

    const counted = await run([
      'aggregate',
      ENGAGEMENT,
      '--where',
      '{"accountId":{"$eq":"acc-1"}}',
      '--select',
      '{"$count":"unordered","amount:avg":"unordered"}',
    ]);

    expect(counted.stderr).toBe('');
    expect(counted.code).toBe(0);
    expect(counted.output).toEqual({ $count: 2, amount: { avg: 30000 } });
  });

  it('service/cli#limits: the output holds nextPageToken when more Objects remain, and --page-token reads the next page', async () => {
    const first = await run(['objects', ACCOUNT, '--page-size', '2', '--order-by', '{"name":"asc"}']);

    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);

    const { data, nextPageToken } = first.output as { data: unknown[]; nextPageToken: string };

    expect(data).toEqual([ACME, GLOBEX]);
    expect(nextPageToken).toEqual(expect.any(String));

    const second = await run([
      'objects',
      ACCOUNT,
      '--page-size',
      '2',
      '--order-by',
      '{"name":"asc"}',
      '--page-token',
      nextPageToken,
    ]);

    expect(second.stderr).toBe('');
    expect(second.code).toBe(0);
    expect(second.output).toEqual({ data: [INITECH], totalCount: '3' });
  });
});

describe('aggregate against node.ts', () => {
  it('service/cli#commands: aggregate computes metrics with groups, from --select and --group-by', async () => {
    const result = await run([
      'aggregate',
      ENGAGEMENT,
      '--select',
      '{"$count":"unordered","amount:sum":"unordered"}',
      '--group-by',
      '{"accountId":"exact"}',
    ]);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.output).toHaveLength(2);

    expect(result.output).toEqual(
      expect.arrayContaining([
        { $group: { accountId: 'acc-1' }, $count: 2, amount: { sum: 60000 } },
        { $group: { accountId: 'acc-2' }, $count: 1, amount: { sum: 15000 } },
      ]),
    );
  });
});

describe('apply against node.ts', () => {
  it('service/cli#commands: apply takes an Object parameter as its primary key, and --validate-only validates and applies nothing', async () => {
    const parameters = ['--parameters', '{"objectToModifyParameter":"eng-3","status":"won"}'];

    const status = async () => (await run(['objects', ENGAGEMENT, 'eng-3', '--select', '["status"]'])).output;

    const validated = await run(['apply', SET_STATUS, ...parameters, '--validate-only']);

    expect(validated.stderr).toBe('');
    expect(validated.code).toBe(0);

    expect(validated.output).toEqual({
      result: 'VALID',
      submissionCriteria: [],
      parameters: {
        objectToModifyParameter: {
          result: 'VALID',
          evaluatedConstraints: [{ type: 'objectQueryResult' }],
          required: true,
        },
        status: { result: 'VALID', evaluatedConstraints: [], required: false, defaultValue: 'open' },
      },
    });

    expect(await status()).toEqual(osdk(ENGAGEMENT, 'eng-3', undefined, { engagementId: 'eng-3', status: 'open' }));

    const applied = await run(['apply', SET_STATUS, ...parameters]);

    expect(applied.stderr).toBe('');
    expect(applied.code).toBe(0);

    expect((applied.output as { modifiedObjects: unknown }).modifiedObjects).toEqual([
      { objectType: ENGAGEMENT, primaryKey: 'eng-3' },
    ]);

    expect(await status()).toEqual(osdk(ENGAGEMENT, 'eng-3', undefined, { engagementId: 'eng-3', status: 'won' }));
  });
});

describe('the output against node.ts', () => {
  it('service/cli#output: an error from the service prints the OSDK error body on stderr and exits with 1, and an apply with validation.result INVALID exits with 1', async () => {
    const error = await run(['objects', ENGAGEMENT, '--where', '{"nope":{"$eq":"x"}}']);

    expect(error.code).toBe(1);
    expect(error.stdout).toBe('');

    expect(error.error).toEqual({
      errorCode: 'NOT_FOUND',
      errorName: 'PropertiesNotFound',
      errorInstanceId: expect.any(String),
      parameters: { objectType: ENGAGEMENT, properties: ['nope'] },
    });

    for (const mode of [[], ['--validate-only']]) {
      const invalid = await run(['apply', CREATE_ACCOUNT, '--parameters', '{"accountId":"acc-noname"}', ...mode]);

      expect(invalid.code).toBe(1);

      expect(invalid.output).toEqual({
        result: 'INVALID',
        submissionCriteria: [],
        parameters: {
          accountId: { result: 'VALID', evaluatedConstraints: [], required: false },
          name: { result: 'INVALID', evaluatedConstraints: [], required: true },
          phase: { result: 'VALID', evaluatedConstraints: [], required: false },
          note: { result: 'VALID', evaluatedConstraints: [], required: false },
          active: { result: 'VALID', evaluatedConstraints: [], required: false },
        },
      });
    }

    expect((await run(['objects', ACCOUNT, 'acc-noname'])).code).toBe(1);
  });
});
