import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionOf, withFunctions, type TestFunction } from '../functions/functions.test-utils.ts';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Sql } from '../db/index.ts';
import { fallibleOf, type Db } from '../db/promise.test-utils.ts';
import type { ReportFault } from '../handler/index.ts';
import { ONTOLOGY_RID, stored, twinGrants, twinIr, unchecked } from '../ontology/stored.test-utils.ts';
import { claimsOf } from '../people.test-utils.ts';
import { now, PERSON } from '../tokens.test-utils.ts';
import { connectV1, connectV2, mcpSettings, startMcpService, type McpService } from './mcp.test-utils.ts';

let service: McpService;
let adminToken: string;

const NS = 'com.example.twin.';
const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;
const SET_ACCOUNT_PHASE = `${NS}set-account-phase`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const PUBLISH_PATH = '/api/ontology-service/v1/publish';
const ACCOUNT_DESCRIPTION = 'A customer of the firm.\nIts second line stays in the one-type answer.';
const LINK_DESCRIPTION = 'The Engagements that the firm runs for an Account.';

function versionTwo(): OntologyIr {
  const ir = twinIr('0.7.0');
  const deprecated = { type: 'deprecated', deprecated: {} };
  const structProbe = ir.ontology.objectTypes[STRUCT_PROBE];
  const setAccountPhase = ir.ontology.actionTypes[SET_ACCOUNT_PHASE];
  const engagement = ir.ontology.objectTypes[ENGAGEMENT];
  const account = ir.ontology.objectTypes[ACCOUNT];

  if (!structProbe || !setAccountPhase || !engagement || !account)
    throw new Error('The twin 0.7.0 IR misses a type that this file changes.');

  structProbe.objectType.status = unchecked(deprecated);

  structProbe.objectType.displayMetadata = unchecked({
    ...structProbe.objectType.displayMetadata,
    description: 'A probe of struct Properties.\nIts second line stays out of the list.',
  });

  setAccountPhase.actionType.metadata.status = unchecked(deprecated);

  setAccountPhase.actionType.metadata.displayMetadata = unchecked({
    ...setAccountPhase.actionType.metadata.displayMetadata,
    description: 'Sets the phase of an Account.\nIts second line stays out of the list.',
  });

  engagement.entityMetadata = unchecked({
    ...engagement.entityMetadata,
    editsHistory: { type: 'config', config: { store: ENGAGEMENT, storeAllPreviousProperties: false } },
  });

  account.entityMetadata = unchecked({
    ...account.entityMetadata,
    editsHistory: { type: 'config', config: { store: ACCOUNT, storeAllPreviousProperties: false } },
  });

  const phase = account.objectType.propertyTypes['phase'];
  const phaseParameter = setAccountPhase.actionType.metadata.parameters['phase'];
  const accountLink = ir.ontology.linkTypes['account-to-engagements'];

  if (!phase || !phaseParameter || !accountLink)
    throw new Error('The twin 0.7.0 IR misses a part that this file describes.');

  account.objectType.displayMetadata = unchecked({
    ...account.objectType.displayMetadata,
    description: ACCOUNT_DESCRIPTION,
  });

  phase.displayMetadata = unchecked({ ...phase.displayMetadata, description: 'The sales phase.' });

  phaseParameter.displayMetadata = unchecked({ ...phaseParameter.displayMetadata, description: 'The new phase.' });

  accountLink.linkType = unchecked({ ...accountLink.linkType, description: LINK_DESCRIPTION });

  return ir;
}

const APPLY_EDITS: TestFunction = {
  apiName: 'applyEdits',
  inputs: [
    { name: 'ops', type: 'stringList' },
    { name: 'more', type: 'stringList' },
  ],
  edits: [ACCOUNT, ENGAGEMENT],
};

const APPLY_EDITS_SOURCE = `
import { createEditBatch } from '@osdk/functions';
const Account = { type: 'object', apiName: '${ACCOUNT}' };
export const functions = {
  applyEdits: async (client, ops, more) => {
    const batch = createEditBatch(client);
    for (const text of [...(ops ?? []), ...(more ?? [])]) {
      const edit = JSON.parse(text);
      if (edit.op === 'create') batch.create(Account, { accountId: edit.key, ...edit.values });
      else batch.delete({ $apiName: Account.apiName, $primaryKey: edit.key });
    }
    return batch.getEdits();
  },
};
`;

beforeAll(async () => {
  service = await startMcpService();

  adminToken = await service.issuer.authkit({ exp: now() + 3600, ...claimsOf('admin') });

  const { ir, functions } = await withFunctions([APPLY_EDITS], APPLY_EDITS_SOURCE, versionTwo());

  const response = await fetch(new URL(PUBLISH_PATH, service.baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await service.issuer.github({ exp: now() + 3600 })}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      product: 'twin',
      ir,
      functions,
      schemaMigrations: { migrations: [] },
      osdkSet: stored(ir).osdkSet,
      grants: {
        ...twinGrants('0.7.0'),
        actionTypes: { ...twinGrants('0.7.0').actionTypes, [actionOf('applyEdits')]: 'accounts:write' },
      },
      validateOnly: false,
    }),
  });

  if (response.status !== 200)
    throw new Error(`The publish of version 2 gave ${response.status}: ${await response.text()}`);

  await service.db.query({
    text: "INSERT INTO ontology_1_objects.account (account_id, name, phase) VALUES ('acc-1', 'Acme', 'customer')",
    values: [],
  });

  await service.db.query({
    text: "INSERT INTO ontology_1_objects.engagement (engagement_id, account_id, title, amount, status) VALUES ('eng-1', 'acc-1', 'Renewal', 1000, 'open'), ('eng-2', 'acc-1', 'Upsell', 2000, 'open')",
    values: [],
  });
});

afterAll(() => service?.stop());

async function call(
  name: string,
  args: Record<string, unknown>,
  target: McpService = service,
  token: string = adminToken,
): Promise<CallToolResult> {
  const { client } = await connectV1(target, { token });

  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

function textOf(result: CallToolResult): string {
  expect(result.content).toHaveLength(1);

  const [block] = result.content;

  expect(block?.type).toBe('text');

  return (block as { text: string }).text;
}

async function route(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  baseUrl: string = service.baseUrl,
): Promise<{ status: number; body: unknown }> {
  const token = await service.issuer.workos({ exp: now() + 3600, ...claimsOf('admin') });

  const response = await fetch(`${baseUrl}/api/v2/ontologies/${ONTOLOGY_RID}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return { status: response.status, body: await response.json() };
}

describe('service/ontology-mcp#tools: tools/list', () => {
  it('service/ontology-mcp#tools/d391cc55 service/ontology-mcp#tools/c7f7e05b service/ontology-mcp#exposure: lists the 8 tools with plain names, in the order of the spec table, with their annotations', async () => {
    const { client } = await connectV1(service);

    try {
      const { tools } = await client.listTools();

      expect(tools.map((tool) => [tool.name, tool.annotations])).toEqual([
        ['describe_object_type', { readOnlyHint: true }],
        ['load_objects', { readOnlyHint: true }],
        ['aggregate_objects', { readOnlyHint: true }],
        ['describe_query', { readOnlyHint: true }],
        ['execute_query', { readOnlyHint: true, idempotentHint: true }],
        ['get_edit_history', { readOnlyHint: true }],
        ['describe_action', { readOnlyHint: true }],
        ['apply_action', { readOnlyHint: false, destructiveHint: true, idempotentHint: false }],
      ]);

      for (const tool of tools) expect(tool.outputSchema).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('service/ontology-mcp#tools: apply_action takes action and parameters, and describe_action takes an optional actionType', async () => {
    const { client } = await connectV1(service);

    try {
      const { tools } = await client.listTools();

      const schema = (name: string) =>
        tools.find((tool) => tool.name === name)?.inputSchema as {
          properties: Record<string, unknown>;
          required?: string[];
        };

      expect(Object.keys(schema('apply_action').properties)).toEqual(['ontology', 'action', 'parameters']);
      expect(schema('apply_action').required).toEqual(['action', 'parameters']);
      expect(Object.keys(schema('describe_action').properties)).toEqual(['ontology', 'actionType']);
      expect(schema('describe_action').required).toBeUndefined();
    } finally {
      await client.close();
    }
  });
});

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);

  if (value === null || typeof value !== 'object') return [];

  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
}

async function described(
  name: 'describe_object_type' | 'describe_action',
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await call(name, args);

  expect(result.isError).toBeFalsy();
  expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);

  return result.structuredContent;
}

describe('the one-type answers of the 2 describe tools, from the compiled Ontology', () => {
  it('service/ontology-mcp#tools/c055e762 ontology/object-link-types/link-types#parts/29472148 service/ontology-mcp#tools/944eb4a7: describe_object_type with an objectType gives the API name, the description, the primary key, the title Property, each Property, and each Link side with the Link Type description that compile keeps', async () => {
    expect(await described('describe_object_type', { objectType: ACCOUNT })).toEqual({
      apiName: ACCOUNT,
      description: ACCOUNT_DESCRIPTION,
      primaryKey: 'accountId',
      titleProperty: 'name',
      properties: {
        accountId: { dataType: { type: 'string' }, required: true },
        name: { dataType: { type: 'string' }, required: true },
        phase: { dataType: { type: 'string' }, required: false, description: 'The sales phase.' },
        note: { dataType: { type: 'string' }, required: false },
        active: { dataType: { type: 'boolean' }, required: false },
      },
      links: { engagements: { target: ENGAGEMENT, cardinality: 'MANY', description: LINK_DESCRIPTION } },
    });

    expect(((await described('describe_object_type', { objectType: ENGAGEMENT })) as { links: unknown }).links).toEqual(
      {
        account: { target: ACCOUNT, cardinality: 'ONE', description: LINK_DESCRIPTION },
      },
    );
  });

  it('service/ontology-mcp#tools/c055e762 service/ontology-mcp#tools/2410b9f8: describe_object_type gives the status of a deprecated Object Type, and no status of an ACTIVE one', async () => {
    expect(await described('describe_object_type', { objectType: STRUCT_PROBE })).toMatchObject({
      apiName: STRUCT_PROBE,
      status: 'DEPRECATED',
    });

    expect(await described('describe_object_type', { objectType: ACCOUNT })).not.toHaveProperty('status');
  });

  it('service/ontology-mcp#tools/7fec797b service/ontology-mcp#tools/944eb4a7: describe_action with an actionType gives the API name, the description, the status that is not ACTIVE, and each parameter with its ID, type, required flag, and description', async () => {
    expect(await described('describe_action', { actionType: SET_ACCOUNT_PHASE })).toEqual({
      apiName: SET_ACCOUNT_PHASE,
      description: 'Sets the phase of an Account.\nIts second line stays out of the list.',
      status: 'DEPRECATED',
      parameters: {
        phase: { dataType: { type: 'string' }, required: false, description: 'The new phase.' },
        objectToModifyParameter: {
          dataType: { type: 'object', objectApiName: ACCOUNT, objectTypeApiName: ACCOUNT },
          required: true,
        },
      },
    });
  });

  it('service/ontology-mcp#tools/2410b9f8: no one-type answer of an Object Type or an Action Type has a RID, an icon, a render hint, a visibility, or an ACTIVE status', async () => {
    const answers = [
      ...(await Promise.all(
        [ACCOUNT, ENGAGEMENT, STRUCT_PROBE].map((objectType) => described('describe_object_type', { objectType })),
      )),
      ...(await Promise.all(
        [SET_ACCOUNT_PHASE, SET_ENGAGEMENT_STATUS, `${NS}create-struct-probe`].map((actionType) =>
          described('describe_action', { actionType }),
        ),
      )),
    ];

    const keys = new Set(answers.flatMap(keysOf));

    for (const key of ['rid', 'linkTypeRid', 'icon', 'typeClasses', 'visibility', 'displayName'])
      expect(keys).not.toContain(key);

    expect(JSON.stringify(answers)).not.toMatch(/ACTIVE|render_hint|ri\./);
  });
});

const VERSION_TWO_MAP = {
  objectTypes: {
    [ACCOUNT]: {
      description: ACCOUNT_DESCRIPTION,
      primaryKey: 'accountId',
      titleProperty: 'name',
      actionTypes: [
        `${NS}close-account-action`,
        `${NS}copy-account-phase`,
        `${NS}create-account`,
        `${NS}delete-account`,
        `${NS}probe-version-check-action`,
        `${NS}set-account-phase (deprecated): Sets the phase of an Account.`,
      ],
      queryFunctions: [],
    },
    [ENGAGEMENT]: {
      primaryKey: 'engagementId',
      titleProperty: 'title',
      actionTypes: [
        `${NS}copy-account-phase`,
        `${NS}create-engagement`,
        `${NS}delete-engagement`,
        `${NS}set-engagement-status`,
      ],
      queryFunctions: [],
    },
    [STRUCT_PROBE]: {
      description: 'A probe of struct Properties.\nIts second line stays out of the list.',
      status: 'DEPRECATED',
      primaryKey: 'probeId',
      titleProperty: 'probeId',
      actionTypes: [
        `${NS}create-struct-probe`,
        `${NS}delete-struct-probe`,
        `${NS}set-relationship-action`,
        `${NS}set-struct-probe-relationship`,
      ],
      queryFunctions: [],
    },
  },
  linkTypes: {
    accountToEngagements: {
      description: LINK_DESCRIPTION,
      sides: [
        { objectType: ACCOUNT, link: 'engagements', cardinality: 'MANY' },
        { objectType: ENGAGEMENT, link: 'account', cardinality: 'ONE' },
      ],
    },
  },
  otherActionTypes: [`${NS}fn-apply-edits`],
  otherQueryFunctions: [],
};

describe('service/ontology-mcp#tools: the business map of describe_object_type with no objectType', () => {
  it('service/ontology-mcp#tools/f9a198f1 service/ontology-mcp#tools/243a47df service/ontology-mcp#tools/ca10453a: the map of the twin gives each Object Type with its Action Types, each Link Type 1 time with its 2 sides, and the other Action Types, as structuredContent and as the same JSON text', async () => {
    const result = await call('describe_object_type', {});

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(VERSION_TWO_MAP);
    expect(JSON.parse(textOf(result))).toEqual(VERSION_TWO_MAP);
  });

  it('service/ontology-mcp#tools/d878a29e: the map has the Link Type description, and the Link Type side of GET .../objectTypes/{objectType}/fullMetadata has none', async () => {
    const map = (await described('describe_object_type', {})) as typeof VERSION_TWO_MAP;

    expect(map.linkTypes.accountToEngagements.description).toBe(LINK_DESCRIPTION);

    const metadata = await route('GET', `/objectTypes/${ACCOUNT}/fullMetadata`);

    expect(metadata.status).toBe(200);
    expect(JSON.stringify(metadata.body)).not.toContain(LINK_DESCRIPTION);
  });

  it('service/ontology-mcp#exposure/8fc48d58: the map of the twin gives StructProbe with the status DEPRECATED and set-account-phase as `(deprecated)`, and no status of an ACTIVE type', async () => {
    const map = (await described('describe_object_type', {})) as typeof VERSION_TWO_MAP;

    expect(map.objectTypes[STRUCT_PROBE].status).toBe('DEPRECATED');

    expect(map.objectTypes[ACCOUNT].actionTypes).toContain(
      `${NS}set-account-phase (deprecated): Sets the phase of an Account.`,
    );

    expect(JSON.stringify(map)).not.toMatch(/ACTIVE|\(active\)/);
  });

  it('service/ontology-mcp#tools/9cbb6e8e: tools/list gives each of the 8 tool descriptions with the first sentence "Call describe_object_type with no name first for a map of the business."', async () => {
    const { client } = await connectV1(service);

    try {
      const { tools } = await client.listTools();

      expect(tools).toHaveLength(8);

      for (const tool of tools)
        expect(tool.description).toMatch(
          /^Call describe_object_type with no name first for a map of the business\. \S/,
        );
    } finally {
      await client.close();
    }
  });
});

describe('the describe_action list adds the status after each Action Type whose status is not ACTIVE', () => {
  it('service/ontology-mcp#tools/7fec797b service/ontology-mcp#tools/944eb4a7: describe_action with no actionType lists each Action Type, with set-account-phase as `com.example.twin.set-account-phase (deprecated): Sets the phase of an Account.`', async () => {
    const result = await call('describe_action', {});

    expect(result.isError).toBeFalsy();

    const expected = {
      actionTypes: [
        'com.example.twin.close-account-action',
        'com.example.twin.copy-account-phase',
        'com.example.twin.create-account',
        'com.example.twin.create-engagement',
        'com.example.twin.create-struct-probe',
        'com.example.twin.delete-account',
        'com.example.twin.delete-engagement',
        'com.example.twin.delete-struct-probe',
        'com.example.twin.fn-apply-edits',
        'com.example.twin.probe-version-check-action',
        'com.example.twin.set-account-phase (deprecated): Sets the phase of an Account.',
        'com.example.twin.set-engagement-status',
        'com.example.twin.set-relationship-action',
        'com.example.twin.set-struct-probe-relationship',
      ],
    };

    expect(result.structuredContent).toEqual(expected);
    expect(JSON.parse(textOf(result))).toEqual(expected);
  });
});

const ACTION_RID = /^ri\.actions\.main\.action\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('service/ontology-mcp#security: the user ID of an apply is the sub of the token', () => {
  it('service/ontology-mcp#security service/ontology-mcp#tools: apply_action writes the edit as the person of the token, and get_edit_history shows that person as userId', async () => {
    const other = 'user_01HR01E61646d696e';

    const applied = await call(
      'apply_action',
      { action: SET_ENGAGEMENT_STATUS, parameters: { objectToModifyParameter: 'eng-1', status: 'won' } },
      service,
      adminToken,
    );

    expect(applied.isError).toBeFalsy();

    const answer = applied.structuredContent as { validation: unknown; edits: unknown; operationId: string };

    expect(JSON.parse(textOf(applied))).toEqual(answer);
    expect(answer.validation).toEqual({ result: 'VALID', submissionCriteria: [], parameters: {} });
    expect(answer.operationId).toMatch(ACTION_RID);

    expect(answer.edits).toEqual({
      type: 'edits',
      edits: [{ type: 'modifyObject', primaryKey: 'eng-1', objectType: ENGAGEMENT }],
      addedObjectCount: 0,
      modifiedObjectsCount: 1,
      deletedObjectsCount: 0,
      addedLinksCount: 0,
      deletedLinksCount: 0,
    });

    const history = await call('get_edit_history', {
      objectType: ENGAGEMENT,
      objectPrimaryKey: { engagementId: 'eng-1' },
    });

    expect(history.isError).toBeFalsy();

    const { data } = history.structuredContent as { data: { userId: string; operationId: string; edit: unknown }[] };

    expect(data.map((entry) => [entry.userId, entry.operationId, entry.edit])).toEqual([
      [
        other,
        answer.operationId,
        {
          type: 'modifyEdit',
          properties: { status: 'won' },
          previousProperties: { status: 'open' },
          includesAllPreviousValues: false,
        },
      ],
    ]);
  });

  it('service/ontology-mcp#security: with the token of the harness, the userId is its sub', async () => {
    const applied = await call(
      'apply_action',
      { action: SET_ACCOUNT_PHASE, parameters: { objectToModifyParameter: 'acc-1', phase: 'prospect' } },
      service,
      service.token,
    );

    expect(applied.isError).toBeFalsy();

    const history = await call(
      'get_edit_history',
      { objectType: ACCOUNT, objectPrimaryKey: { accountId: 'acc-1' } },
      service,
      service.token,
    );

    const { data } = history.structuredContent as { data: { userId: string }[] };

    expect(data.map((entry) => entry.userId)).toEqual([PERSON]);
  });
});

describe('service/ontology-mcp#exposure: the tools accept every Action Type', () => {
  it('service/ontology-mcp#exposure service/ontology-mcp#tools: apply_action applies a deprecated Action Type, and load_objects reads the edit back', async () => {
    const applied = await call('apply_action', {
      action: SET_ACCOUNT_PHASE,
      parameters: { objectToModifyParameter: 'acc-1', phase: 'renewed' },
    });

    expect(applied.isError).toBeFalsy();
    expect((applied.structuredContent as { validation: { result: string } }).validation.result).toBe('VALID');

    const loaded = await call('load_objects', { objectSet: { type: 'base', objectType: ACCOUNT }, select: ['phase'] });

    expect((loaded.structuredContent as { data: unknown[] }).data).toEqual([
      { __rid: expect.any(String), __primaryKey: 'acc-1', __apiName: ACCOUNT, accountId: 'acc-1', phase: 'renewed' },
    ]);
  });
});

describe('service/ontology-mcp#errors: an apply that fails validation is an isError result', () => {
  it('service/ontology-mcp#errors service/ontology-mcp#tools/63cfeb50: apply_action with a missing required parameter gives isError, with the INVALID validation of the route as structuredContent and as text', async () => {
    const parameters = { phase: 'churned' };

    const result = await call('apply_action', { action: SET_ACCOUNT_PHASE, parameters });

    const answer = await route('POST', `/actions/${SET_ACCOUNT_PHASE}/apply`, {
      parameters,
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
    });

    expect(answer.status).toBe(200);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(answer.body);
    expect(textOf(result)).toBe(JSON.stringify(result.structuredContent));

    const { validation } = result.structuredContent as {
      validation: { result: string; parameters: Record<string, { result: string; required: boolean }> };
    };

    expect(validation.result).toBe('INVALID');
    expect(validation.parameters['objectToModifyParameter']).toMatchObject({ result: 'INVALID', required: true });
    expect(result.structuredContent).not.toHaveProperty('operationId');
  });

  it('service/ontology-mcp#errors: apply_action on the same Action with valid parameters gives no isError', async () => {
    const result = await call('apply_action', {
      action: SET_ACCOUNT_PHASE,
      parameters: { objectToModifyParameter: 'acc-1', phase: 'renewed' },
    });

    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { validation: { result: string } }).validation.result).toBe('VALID');
  });
});

describe('service/ontology-mcp#errors: the fault text of apply_action', () => {
  function failingWrites(db: Db): Db {
    return {
      query: (sql) => db.query(sql),
      stream: (sql) => db.stream(sql),
      snapshot: (run) => db.snapshot(run),
      transaction: () => Promise.reject(new Error('the commit was lost')),
    };
  }

  it('service/ontology-mcp#errors: a 5xx of apply_action says that the Action may have applied, and names get_edit_history, after the error body', async () => {
    const reported: unknown[] = [];
    const reportFault: ReportFault = (error) => void reported.push(error);

    const baseUrl = await service.serve(mcpSettings, { db: fallibleOf(failingWrites(service.db)), reportFault });

    const faulty = { ...service, baseUrl, url: new URL('/api/mcp', baseUrl) };

    const result = await call(
      'apply_action',
      { action: SET_ENGAGEMENT_STATUS, parameters: { objectToModifyParameter: 'eng-1', status: 'void' } },
      faulty,
    );

    expect(result.isError).toBe(true);

    const body = result.structuredContent as {
      errorCode: string;
      errorName: string;
      errorInstanceId: string;
      parameters: unknown;
    };

    expect(body).toEqual({
      errorCode: 'INTERNAL',
      errorName: 'Default:Internal',
      errorInstanceId: expect.any(String),
      parameters: {},
    });

    expect(textOf(result)).toBe(
      `${JSON.stringify(body)}\nThe Action may have applied. Call \`get_edit_history\` on the Objects before you call \`apply_action\` again.`,
    );

    expect(reported).toEqual([new Error('the commit was lost')]);
  });

  it('service/ontology-mcp#errors: a 4xx of apply_action holds the error body alone', async () => {
    const result = await call('apply_action', { action: `${NS}no-such-action`, parameters: {} });

    expect(result.isError).toBe(true);

    const body = result.structuredContent as { errorName: string };

    expect(body.errorName).toBe('ActionTypeNotFound');
    expect(textOf(result)).toBe(JSON.stringify(body));
  });
});

describe('the MCP route gives each apply a deadline of 50 s after the request arrives', () => {
  const PAST_DEADLINE = {
    errorCode: 'INVALID_ARGUMENT',
    errorName: 'ActionDeadlineExceeded',
    errorInstanceId: expect.any(String),
    parameters: {},
  };

  let step: number | undefined;
  let poolWait: number | undefined;
  let limits: unknown[] = [];

  function advancingDb(db: Db): Db {
    const advance = () => {
      if (step === undefined) return;

      vi.setSystemTime(Date.now() + step);

      step = undefined;
    };

    return {
      query: async <Row extends object>(sql: Sql) => {
        const rows = await db.query<Row>(sql);

        advance();

        return rows;
      },
      stream: (sql) => db.stream(sql),
      snapshot: (run) => db.snapshot(run),
      transaction: (run) => {
        if (poolWait !== undefined) vi.setSystemTime(Date.now() + poolWait);

        poolWait = undefined;

        return db.transaction((tx) => {
          let first = true;

          return run({
            ...tx,
            query: <Row extends object>(sql: Sql) => {
              if (first) limits.push(sql.values[0]);

              first = false;

              return tx.query<Row>(sql);
            },
          });
        });
      },
    };
  }

  let slow: McpService;

  async function callSlow(name: string, args: Record<string, unknown>, age?: number): Promise<CallToolResult> {
    const client = await connectV2(slow, { pin: '2026-07-28', token: adminToken });

    try {
      if (age !== undefined) step = age;

      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    } finally {
      await client.close();
    }
  }

  const statusOf = async (engagement: string) => {
    const loaded = await callSlow('load_objects', {
      objectSet: { type: 'base', objectType: ENGAGEMENT },
      select: ['status'],
    });

    return (loaded.structuredContent as { data: { __primaryKey: string; status: string }[] }).data.find(
      (row) => row.__primaryKey === engagement,
    )?.status;
  };

  const historyOf = async (engagement: string) =>
    (await callSlow('get_edit_history', { objectType: ENGAGEMENT, objectPrimaryKey: { engagementId: engagement } }))
      .structuredContent;

  beforeAll(async () => {
    const baseUrl = await service.serve(mcpSettings, { db: fallibleOf(advancingDb(service.db)) });

    slow = { ...service, baseUrl, url: new URL('/api/mcp', baseUrl) };

    await service.db.query({
      text: "INSERT INTO ontology_1_objects.engagement (engagement_id, account_id, title, amount, status) VALUES ('eng-3', 'acc-1', 'Slow', 3000, 'open'), ('eng-4', 'acc-1', 'Slower', 4000, 'open'), ('eng-5', 'acc-1', 'Direct', 5000, 'open'), ('eng-6', 'acc-1', 'Queued', 6000, 'open'), ('eng-7', 'acc-1', 'Queued longer', 7000, 'open'), ('eng-8', 'acc-1', 'Locked', 8000, 'open')",
      values: [],
    });
  });

  beforeEach(() => {
    limits = [];

    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => vi.useRealTimers());

  function applySlow(engagement: string, status: string, age: number): Promise<CallToolResult> {
    return callSlow(
      'apply_action',
      { action: SET_ENGAGEMENT_STATUS, parameters: { objectToModifyParameter: engagement, status } },
      age,
    );
  }

  it('service/ontology-mcp#long-action-runs service/storage#writes: an apply that reaches the check 45.000 s after the request arrived writes its edit, and its write transaction gets the limit 5000ms', async () => {
    const applied = await applySlow('eng-4', 'won', 45_000);

    expect(applied.isError).toBeFalsy();
    expect((applied.structuredContent as { validation: { result: string } }).validation.result).toBe('VALID');
    expect(limits).toEqual(['5000ms']);

    expect(await statusOf('eng-4')).toBe('won');
  });

  it('service/ontology-mcp#long-action-runs: an apply that reaches the check 50.000 s after the request arrived writes nothing, and gets 400 ActionDeadlineExceeded with parameters {}', async () => {
    const applied = await applySlow('eng-3', 'won', 50_000);

    expect(applied.isError).toBe(true);
    expect(applied.structuredContent).toEqual(PAST_DEADLINE);
    expect(textOf(applied)).toBe(JSON.stringify(applied.structuredContent));
    expect(limits).toEqual([]);

    expect(await statusOf('eng-3')).toBe('open');

    expect(await historyOf('eng-3')).toEqual({ data: [], totalCount: 0 });
  });

  it('service/ontology-mcp#long-action-runs service/storage#writes: an apply whose wait for its write connection ends 45.000 s after the request arrived writes its edit, with the limit 5000ms', async () => {
    poolWait = 45_000;

    const applied = await callSlow('apply_action', {
      action: SET_ENGAGEMENT_STATUS,
      parameters: { objectToModifyParameter: 'eng-7', status: 'won' },
    });

    expect(poolWait).toBeUndefined();
    expect(applied.isError).toBeFalsy();
    expect(limits).toEqual(['5000ms']);

    expect(await statusOf('eng-7')).toBe('won');
  });

  it('service/ontology-mcp#long-action-runs: an apply whose wait for its write connection ends 50.000 s after the request arrived writes nothing, and gets 400 ActionDeadlineExceeded', async () => {
    poolWait = 50_000;

    const applied = await callSlow('apply_action', {
      action: SET_ENGAGEMENT_STATUS,
      parameters: { objectToModifyParameter: 'eng-6', status: 'won' },
    });

    expect(poolWait).toBeUndefined();
    expect(applied.isError).toBe(true);
    expect(applied.structuredContent).toEqual(PAST_DEADLINE);
    expect(limits).toEqual([]);

    expect(await statusOf('eng-6')).toBe('open');

    expect(await historyOf('eng-6')).toEqual({ data: [], totalCount: 0 });
  });

  it('service/ontology-mcp#long-action-runs: an apply that reaches the check 49.500 s after the request arrived, on a row that another transaction holds, gets a tool error with the deadline answer when its limit ends, and writes nothing', async () => {
    let release = (): void => undefined;
    let locked = (): void => undefined;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));

    const holder = service.db.transaction(async (tx) => {
      await tx.query({
        text: "SELECT 1 FROM ontology_1_objects.engagement WHERE engagement_id = 'eng-8' FOR UPDATE",
        values: [],
      });

      locked();

      await new Promise<void>((resolve) => (release = resolve));
    });

    try {
      await isLocked;

      const started = performance.now();

      const applied = await applySlow('eng-8', 'won', 49_500);

      const elapsed = performance.now() - started;

      expect(applied.isError).toBe(true);
      expect(applied.structuredContent).toEqual(PAST_DEADLINE);
      expect(limits).toEqual(['500ms']);
      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      release();

      await holder;
    }

    expect(await statusOf('eng-8')).toBe('open');

    expect(await historyOf('eng-8')).toEqual({ data: [], totalCount: 0 });
  });

  it('service/ontology-mcp#long-action-runs: the same Action on the OSDK apply route, 50.001 s after the request arrived, writes its edit, because its deadline is 120 s', async () => {
    step = 50_001;

    const answer = await route(
      'POST',
      `/actions/${SET_ENGAGEMENT_STATUS}/apply`,
      { parameters: { objectToModifyParameter: 'eng-5', status: 'won' }, options: { mode: 'VALIDATE_AND_EXECUTE' } },
      slow.baseUrl,
    );

    expect(answer.status).toBe(200);
    expect((answer.body as { validation: { result: string } }).validation.result).toBe('VALID');
    expect(step).toBeUndefined();
    expect(limits).toEqual(['69999ms']);

    expect(await statusOf('eng-5')).toBe('won');
  });
});

describe('service/ontology-mcp#tools: the 2 answer shapes of returnEdits', () => {
  const apply = (ops: string[]) =>
    call('apply_action', { action: actionOf('applyEdits'), parameters: { ops, more: [] } });

  const create = (key: string) => JSON.stringify({ op: 'create', key, values: { name: key } });

  it('service/ontology-mcp#tools: apply_action with no edit gives no edits key', async () => {
    const result = await apply([]);

    expect(result.isError).toBeFalsy();

    expect(result.structuredContent).toEqual({
      operationId: expect.any(String),
      validation: { result: 'VALID', submissionCriteria: [], parameters: {} },
    });
  });

  it('service/ontology-mcp#tools: apply_action with 5,001 creates gives largeScaleEdits', async () => {
    const result = await apply(Array.from({ length: 5001 }, (_, i) => create(`acc-m-${i}`)));

    expect(result.structuredContent).toMatchObject({
      edits: { type: 'largeScaleEdits', editedObjectTypes: [ACCOUNT] },
    });
  });

  it('service/ontology-mcp#tools: the description of apply_action holds the new sentence', async () => {
    const { client } = await connectV1(service);

    try {
      const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'apply_action');

      expect(tool?.description).toContain(
        'The answer lists the edits, or only the edited Object Types when the Action edits more than 5,000 Objects.',
      );
    } finally {
      await client.close();
    }
  });
});
