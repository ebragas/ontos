import { linkTypeRid, ridNamespace } from '@ericbragas/ontos-service/convert';
import { orThrow } from './fallible.ts';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_2_PAGE_TOKEN,
  cli,
  STUB_RID,
  stubExchange,
  stubMetadata,
  replay,
  STUB,
  type Exchange,
  STUB_CONFIG,
  stubConfig,
  stubFetch,
  stubOntologies,
  withRequest,
  type Handler,
} from './cli.test-utils.ts';

const ACCOUNT = 'com.example.twin.Account';
const ENGAGEMENT = 'com.example.twin.Engagement';
const STRUCT_PROBE = 'com.example.twin.StructProbe';
const LINK_RID = linkTypeRid(orThrow(ridNamespace(STUB_RID)), 'account-to-engagements');
const flags = ['--app', 'twin', '--url', STUB];
const env = { ONTOLOGY_TOKEN: 't' };

const fullMetadata =
  (metadata: unknown): Handler =>
  ({ method, url }) =>
    method === 'GET' && new URL(url).pathname === `/api/v2/ontologies/${STUB_CONFIG.productRid}/fullMetadata`
      ? Response.json(metadata)
      : undefined;

function osdk(
  type: string,
  primaryKey: string,
  title: string,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...properties,
    $apiName: type,
    $objectType: type,
    $primaryKey: primaryKey,
    $title: title,
    $objectSpecifier: `${type}:${primaryKey}`,
  };
}

const run = (args: readonly string[], ...handlers: Handler[]) =>
  cli([...args, ...flags], { fetch: stubFetch(stubConfig, ...handlers), env });

describe('ontology describe', () => {
  it('service/cli#commands: with no name, describe lists the Object Types, the Link sides with their Link Type RID, and the Action Types, and with a side API name it shows that side', async () => {
    const result = await run(['describe'], fullMetadata(stubMetadata()));

    expect(result.code).toBe(0);

    expect(result.output).toEqual({
      objectTypes: [
        { apiName: ACCOUNT, displayName: 'Account' },
        { apiName: ENGAGEMENT, displayName: 'Engagement' },
        { apiName: STRUCT_PROBE, displayName: 'Struct Probe' },
      ],
      linkTypes: [
        {
          objectType: ACCOUNT,
          apiName: 'engagements',
          displayName: 'Engagement',
          target: ENGAGEMENT,
          cardinality: 'MANY',
          linkTypeRid: LINK_RID,
        },
        {
          objectType: ENGAGEMENT,
          apiName: 'account',
          displayName: 'Account',
          target: ACCOUNT,
          cardinality: 'ONE',
          linkTypeRid: LINK_RID,
        },
      ],
      actionTypes: [
        { apiName: 'com.example.twin.create-account', displayName: 'Create Account' },
        { apiName: 'com.example.twin.create-engagement', displayName: 'Create Engagement' },
        { apiName: 'com.example.twin.set-engagement-status', displayName: 'Modify Engagement' },
        { apiName: 'com.example.twin.delete-account', displayName: 'Delete Account' },
        { apiName: 'com.example.twin.delete-engagement', displayName: 'Delete Engagement' },
        { apiName: 'com.example.twin.close-account-action', displayName: 'Close account' },
        { apiName: 'com.example.twin.set-account-phase', displayName: 'Modify Account' },
        { apiName: 'com.example.twin.copy-account-phase', displayName: 'Modify Engagement' },
        { apiName: 'com.example.twin.probe-version-check-action', displayName: 'Probe version check' },
        { apiName: 'com.example.twin.create-struct-probe', displayName: 'Create Struct Probe' },
        { apiName: 'com.example.twin.set-struct-probe-relationship', displayName: 'Modify Struct Probe' },
        { apiName: 'com.example.twin.set-relationship-action', displayName: 'Set relationship' },
        { apiName: 'com.example.twin.delete-struct-probe', displayName: 'Delete Struct Probe' },
      ],
    });

    const side = await run(['describe', 'engagements'], fullMetadata(stubMetadata()));

    expect(side.output).toEqual({
      linkTypes: [
        {
          objectType: ACCOUNT,
          apiName: 'engagements',
          displayName: 'Engagement',
          target: ENGAGEMENT,
          cardinality: 'MANY',
          linkTypeRid: LINK_RID,
        },
      ],
    });
  });

  it('service/cli#commands: with a name, describe shows 1 Object Type with its Properties and Links, or 1 Action Type with its parameters', async () => {
    const account = await run(['describe', ACCOUNT], fullMetadata(stubMetadata()));

    expect(account.code).toBe(0);

    expect(account.output).toEqual({
      objectType: {
        apiName: ACCOUNT,
        displayName: 'Account',
        pluralDisplayName: 'Accounts',
        primaryKey: 'accountId',
        titleProperty: 'name',
        properties: {
          phase: { displayName: 'Phase', dataType: { type: 'string' } },
          accountId: { displayName: 'Account ID', dataType: { type: 'string' } },
          name: { displayName: 'Name', dataType: { type: 'string' } },
          note: { displayName: 'Note', dataType: { type: 'string' } },
          active: { displayName: 'Active', dataType: { type: 'boolean' } },
        },
        links: [
          {
            objectType: ACCOUNT,
            apiName: 'engagements',
            displayName: 'Engagement',
            target: ENGAGEMENT,
            cardinality: 'MANY',
            linkTypeRid: LINK_RID,
          },
        ],
      },
    });

    const close = await run(['describe', 'com.example.twin.close-account-action'], fullMetadata(stubMetadata()));

    expect(close.output).toEqual({
      actionType: {
        apiName: 'com.example.twin.close-account-action',
        displayName: 'Close account',
        parameters: {
          reason: { displayName: 'Reason', dataType: { type: 'string' }, required: false, typeClasses: [] },
          account: {
            displayName: 'Account',
            dataType: { type: 'object', objectApiName: ACCOUNT, objectTypeApiName: ACCOUNT },
            required: true,
            typeClasses: [],
          },
        },
      },
    });

    const unknown = await run(['describe', 'nope'], fullMetadata(stubMetadata()));

    expect(unknown.code).toBe(1);
    expect(unknown.error).toEqual({ message: 'No Object Type, Link Type, or Action Type has the API name nope.' });
  });

  it("service/cli#commands: describe shows the description of each Object Type, Property, and Action Type, and a Link Type's display name, target, and cardinality", async () => {
    const metadata = stubMetadata() as {
      objectTypes: {
        [ACCOUNT]: { objectType: { description?: string; properties: { phase: { description?: string } } } };
      };
      actionTypes: { 'com.example.twin.create-account': { description?: string } };
    };

    const account = metadata.objectTypes[ACCOUNT].objectType;

    account.description = 'A customer or a prospect.';

    account.properties.phase.description = 'prospect, customer, or closed';

    metadata.actionTypes['com.example.twin.create-account'].description = 'Creates 1 Account.';

    const list = await run(['describe'], fullMetadata(metadata));

    const listed = list.output as { objectTypes: unknown[]; actionTypes: unknown[] };

    expect(listed.objectTypes[0]).toEqual({
      apiName: ACCOUNT,
      displayName: 'Account',
      description: 'A customer or a prospect.',
    });

    expect(listed.actionTypes[0]).toEqual({
      apiName: 'com.example.twin.create-account',
      displayName: 'Create Account',
      description: 'Creates 1 Account.',
    });

    const one = await run(['describe', ACCOUNT], fullMetadata(metadata));

    const shown = (one.output as { objectType: { description: string; properties: Record<string, unknown> } })
      .objectType;

    expect(shown.description).toBe('A customer or a prospect.');

    expect(shown.properties['phase']).toEqual({
      displayName: 'Phase',
      description: 'prospect, customer, or closed',
      dataType: { type: 'string' },
    });

    const action = await run(['describe', 'com.example.twin.create-account'], fullMetadata(metadata));

    expect((action.output as { actionType: { description: string } }).actionType.description).toBe(
      'Creates 1 Account.',
    );

    const link = await run(['describe', 'account'], fullMetadata(metadata));

    expect(link.output).toEqual({
      linkTypes: [
        {
          objectType: ENGAGEMENT,
          apiName: 'account',
          displayName: 'Account',
          target: ACCOUNT,
          cardinality: 'ONE',
          linkTypeRid: LINK_RID,
        },
      ],
    });
  });
});

describe('ontology describe <Link Type>', () => {
  const COMPANY = 'com.example.twin.Company';
  const COMPANY_LINK_RID = linkTypeRid(orThrow(ridNamespace(STUB_RID)), 'company-to-subsidiaries');

  const parent = {
    objectType: COMPANY,
    apiName: 'parent',
    displayName: 'Parent',
    target: COMPANY,
    cardinality: 'ONE',
    linkTypeRid: COMPANY_LINK_RID,
  };

  const subsidiaries = {
    objectType: COMPANY,
    apiName: 'subsidiaries',
    displayName: 'Subsidiaries',
    target: COMPANY,
    cardinality: 'MANY',
    linkTypeRid: COMPANY_LINK_RID,
  };

  function withCompany(ontologyRid = STUB_RID, ...others: (typeof parent)[]): unknown {
    const metadata = stubMetadata() as { ontology: { rid: string }; objectTypes: Record<string, unknown> };

    expect(metadata.ontology.rid).toBe(STUB_RID);

    metadata.ontology.rid = ontologyRid;

    const side = ({ apiName, displayName, cardinality, linkTypeRid }: typeof parent) => ({
      apiName,
      displayName,
      status: 'ACTIVE',
      objectTypeApiName: COMPANY,
      cardinality,
      linkTypeRid,
    });

    metadata.objectTypes[COMPANY] = {
      objectType: {
        apiName: COMPANY,
        displayName: 'Company',
        pluralDisplayName: 'Companies',
        primaryKey: 'companyId',
        titleProperty: 'companyId',
        properties: {},
      },
      linkTypes: [parent, subsidiaries, ...others].map(side),
    };

    return metadata;
  }

  it('describe <Link Type API name> makes the Link Type RID from the name, and shows the Link Type with its 2 sides', async () => {
    const result = await run(['describe', 'companyToSubsidiaries'], fullMetadata(withCompany()));

    expect(result.code).toBe(0);

    expect(result.output).toEqual({
      linkType: { apiName: 'companyToSubsidiaries', rid: COMPANY_LINK_RID, sides: [parent, subsidiaries] },
    });
  });

  it('a name with the API namespace, or a name that matches no type, side, or Link Type, gets the error of an unknown name', async () => {
    for (const name of ['com.example.twin.companyToSubsidiaries', 'companyToParents']) {
      const result = await run(['describe', name], fullMetadata(withCompany()));

      expect(result.code).toBe(1);
      expect(result.error).toEqual({ message: `No Object Type, Link Type, or Action Type has the API name ${name}.` });
    }
  });

  it('service/cli#commands: the Link Type RID comes from the product RID of client-config, with a listed Ontology RID that differs from it', async () => {
    const installed = {
      rid: 'ri.ontology.main.ontology.6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7',
      apiName: 'acme',
      displayName: 'Acme',
      description: '',
    };

    expect(installed.rid).not.toBe(STUB_CONFIG.productRid);

    const metadata: Handler = ({ method, url }) =>
      method === 'GET' && new URL(url).pathname === `/api/v2/ontologies/${installed.rid}/fullMetadata`
        ? Response.json(withCompany(installed.rid))
        : undefined;

    const fetch = stubFetch(stubOntologies(installed), stubConfig, metadata);

    const result = await cli(['describe', 'companyToSubsidiaries', ...flags], { fetch, env });

    expect(result.error).toBeUndefined();

    expect(result.output).toEqual({
      linkType: { apiName: 'companyToSubsidiaries', rid: COMPANY_LINK_RID, sides: [parent, subsidiaries] },
    });
  });

  it('a Link side with the name wins over the Link Type with that API name', async () => {
    const side = {
      ...subsidiaries,
      apiName: 'companyToSubsidiaries',
      linkTypeRid: 'ri.ontology.main.relation.00000000-0000-4000-8000-000000000000',
    };

    const result = await run(['describe', 'companyToSubsidiaries'], fullMetadata(withCompany(STUB_RID, side)));

    expect(result.code).toBe(0);
    expect(result.output).toEqual({ linkTypes: [side] });
  });
});

describe('ontology objects with a primary key', () => {
  it('service/cli#commands: objects <ObjectType> <primary key> loads 1 Object', async () => {
    const result = await run(
      ['objects', ACCOUNT, 'acc-1'],
      replay(stubExchange('client', 1), stubExchange('client', 6)),
    );

    expect(result.code).toBe(0);

    expect(result.output).toEqual(
      osdk(ACCOUNT, 'acc-1', 'Acme', { phase: 'customer', accountId: 'acc-1', name: 'Acme' }),
    );
  });

  const fetchOneOfNoSuch = (status: number, responseBody: unknown) => {
    const exchange = stubExchange('client', 6) as Exchange & { requestBody: { objectSet: { where: object } } };
    const where = { ...exchange.requestBody.objectSet.where, value: 'no-such' };

    return replay({
      ...exchange,
      requestBody: { ...exchange.requestBody, objectSet: { ...exchange.requestBody.objectSet, where } },
      status,
      responseBody,
    });
  };

  it('service/cli#output: objects <ObjectType> <primary key> of a missing Object prints an ObjectNotFound body on stderr and exits 1', async () => {
    const result = await run(
      ['objects', ACCOUNT, 'no-such'],
      replay(stubExchange('client', 1)),
      fetchOneOfNoSuch(200, { data: [] }),
    );

    expect(result.code).toBe(1);

    expect(result.error).toEqual({
      errorCode: 'NOT_FOUND',
      errorName: 'ObjectNotFound',
      parameters: { objectType: ACCOUNT, primaryKey: 'no-such' },
    });
  });

  it('service/cli#output: another error of objects <ObjectType> <primary key> keeps its output', async () => {
    const body = {
      errorCode: 'NOT_FOUND',
      errorName: 'ObjectTypeNotFound',
      errorInstanceId: 'e-1',
      parameters: { objectType: ACCOUNT },
    };

    const result = await run(
      ['objects', ACCOUNT, 'no-such'],
      replay(stubExchange('client', 1)),
      fetchOneOfNoSuch(404, body),
    );

    expect(result.code).toBe(1);
    expect(result.error).toEqual(body);
  });

  it('service/cli#commands: --link loads the Objects of 1 Link of the Object', async () => {
    const many = await run(
      ['objects', ACCOUNT, 'acc-1', '--link', 'engagements'],
      replay(
        stubExchange('client', 1),
        stubExchange('client', 4),
        withRequest(stubExchange('client', 8), { pageSize: 100 }),
      ),
    );

    expect(many.code).toBe(0);

    const data = (many.output as { data: { $primaryKey: string }[] }).data;

    expect(data.map((object) => object.$primaryKey)).toEqual(['eng-1', 'eng-3', 'eng-2']);

    expect(data[0]).toEqual(
      osdk(ENGAGEMENT, 'eng-1', 'Discovery workshop', {
        accountId: 'acc-1',
        createdAt: '2026-11-03T22:46:35.465Z',
        amount: 12000,
        title: 'Discovery workshop',
        engagementId: 'eng-1',
        status: 'won',
      }),
    );

    const one = await run(
      ['objects', ENGAGEMENT, 'eng-4', '--link', 'account'],
      replay(
        stubExchange('client', 4),
        stubExchange('client', 1),
        withRequest(stubExchange('client', 10), { pageSize: 100 }),
      ),
    );

    expect(one.code).toBe(0);

    expect(one.output).toEqual({
      data: [osdk(ACCOUNT, 'acc-2', 'Globex', { phase: 'prospect', accountId: 'acc-2', name: 'Globex' })],
      totalCount: '1',
    });
  });
});

describe('ontology aggregate', () => {
  it('service/cli#commands: aggregate computes metrics with groups, from --select and --group-by', async () => {
    const result = await run(
      [
        'aggregate',
        ENGAGEMENT,
        '--select',
        '{"$count":"unordered","amount:sum":"unordered","amount:max":"unordered"}',
        '--group-by',
        '{"status":"exact"}',
      ],
      replay(stubExchange('client', 4), stubExchange('client', 11)),
    );

    expect(result.error).toBeUndefined();
    expect(result.code).toBe(0);

    expect(result.output).toEqual([
      { $group: { status: 'lost' }, $count: 1, amount: { sum: 15000, max: 15000 } },
      { $group: { status: 'open' }, $count: 3, amount: { sum: 84000, max: 48000 } },
      { $group: { status: 'won' }, $count: 2, amount: { sum: 21000, max: 12000 } },
    ]);
  });

  it('service/cli#commands: aggregate computes metrics with no groups, on the Objects that --where selects', async () => {
    const result = await run(
      [
        'aggregate',
        ENGAGEMENT,
        '--where',
        '{"accountId":{"$eq":"acc-1"}}',
        '--select',
        '{"$count":"unordered","amount:avg":"unordered"}',
      ],
      replay(stubExchange('client', 4), stubExchange('client', 12)),
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ $count: 3, amount: { avg: 22000 } });
  });

  it('service/cli#commands: aggregate refuses a --select metric key with no :<metric>, or a --select that is not an object, before any call, and names the form', async () => {
    const cases: [string, string, string][] = [
      ['{"feeDollars":"sum"}', 'feeDollars', 'feeDollars:sum'],
      ['{"$count":"unordered","amount:":"unordered"}', 'amount:', 'amount:sum'],
    ];

    for (const [select, key, example] of cases) {
      const fetch = stubFetch(stubConfig);

      const result = await cli(['aggregate', ENGAGEMENT, '--select', select, ...flags], { fetch, env });

      expect(result.code).toBe(1);

      expect(result.error).toEqual({
        message: `--select key "${key}" has no metric: write <Property>:<metric>, such as "${example}", or $count.`,
      });

      expect(fetch.calls).toEqual([]);
    }

    const fetch = stubFetch(stubConfig);

    const list = await cli(['aggregate', ENGAGEMENT, '--select', '["feeDollars"]', ...flags], { fetch, env });

    expect(list.code).toBe(1);

    expect(list.error).toEqual({
      message: '--select is a JSON object of <Property>:<metric> keys, such as {"feeDollars:sum":"unordered"}.',
    });

    expect(fetch.calls).toEqual([]);
  });
});

describe('the options of objects', () => {
  it('service/cli#commands: objects takes --where in the OSDK syntax as JSON, --order-by, and --select, and the stock client converts each one to the wire form', async () => {
    const where = stubExchange('client', 5);
    const fetch = stubFetch(stubConfig, replay(stubExchange('client', 4), withRequest(where, { pageSize: 100 })));

    const result = await cli(
      [
        'objects',
        ENGAGEMENT,
        '--where',
        '{"$and":[{"amount":{"$gte":10000}},{"status":{"$ne":"lost"}}]}',
        '--order-by',
        '{"amount":"desc"}',
        ...flags,
      ],
      { fetch, env },
    );

    expect(result.error).toBeUndefined();
    expect(result.code).toBe(0);

    expect((result.output as { data: { $primaryKey: string }[] }).data.map((object) => object.$primaryKey)).toEqual([
      'eng-2',
      'eng-6',
      'eng-1',
    ]);
  });

  it('service/cli#commands: --select gives the Properties of each Object, and the stock client sends them as selectV2', async () => {
    const request = {
      objectSet: { type: 'base', objectType: ENGAGEMENT },
      select: [],
      selectV2: [
        { type: 'property', apiName: 'title' },
        { type: 'property', apiName: 'amount' },
      ],
      loadPropertySecurities: false,
      excludeRid: true,
      snapshot: false,
      pageSize: 100,
    };

    const answer = {
      data: [{ title: 'Pilot', amount: 15000, __primaryKey: 'eng-4', __title: 'Pilot', __apiName: ENGAGEMENT }],
    };

    const loadObjects = {
      method: 'POST',
      path: `/api/v2/ontologies/${STUB_CONFIG.productRid}/objectSets/loadObjects`,
      requestBody: request,
      status: 200,
      responseBody: answer,
    };

    const fetch = stubFetch(stubConfig, replay(stubExchange('client', 4), loadObjects));

    const result = await cli(['objects', ENGAGEMENT, '--select', '["title","amount"]', ...flags], { fetch, env });

    expect(JSON.parse(fetch.calls.at(-1)?.body ?? '{}')).toEqual(request);
    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ data: [osdk(ENGAGEMENT, 'eng-4', 'Pilot', { title: 'Pilot', amount: 15000 })] });
  });
});

describe('the paging limits of objects', () => {
  it('service/cli#limits: objects returns 100 Objects by default, and --page-size asks for up to 10,000', async () => {
    const all = withRequest(stubExchange('client', 13), { snapshot: false });

    const max = await run(['objects', ACCOUNT, '--page-size', '10000'], replay(stubExchange('client', 1), all));

    expect(max.code).toBe(0);
    expect((max.output as { data: unknown[] }).data).toHaveLength(3);

    const byDefault = await run(
      ['objects', ACCOUNT],
      replay(stubExchange('client', 1), withRequest(all, { pageSize: 100 })),
    );

    expect(byDefault.code).toBe(0);
    expect((byDefault.output as { data: unknown[] }).data).toHaveLength(3);

    for (const size of ['10001', '0', '-1', '2.5']) {
      const refused = await run(['objects', ACCOUNT, `--page-size=${size}`], replay(stubExchange('client', 1)));

      expect(refused.code).toBe(1);
      expect(refused.error).toEqual({ message: `--page-size is a whole number from 1 to 10000, not ${size}.` });
    }
  });

  it('service/cli#limits: the output holds nextPageToken when more Objects remain, and --page-token reads the next page', async () => {
    const first = await run(
      ['objects', ACCOUNT, '--page-size', '2', '--order-by', '{"name":"asc"}'],
      replay(stubExchange('client', 1), stubExchange('client', 2)),
    );

    const { nextPageToken } = first.output as { nextPageToken: string };

    expect(nextPageToken).toBe(CLIENT_2_PAGE_TOKEN);

    const second = await run(
      ['objects', ACCOUNT, '--page-size', '2', '--order-by', '{"name":"asc"}', '--page-token', nextPageToken],
      replay(stubExchange('client', 1), stubExchange('client', 3)),
    );

    expect(second.code).toBe(0);

    expect(second.output).toEqual({
      data: [osdk(ACCOUNT, 'acc-3', 'Initech', { phase: 'customer', accountId: 'acc-3', name: 'Initech' })],
      totalCount: '3',
    });
  });
});
