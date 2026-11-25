import type { Server } from 'node:http';
import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DiscoveredFunction, PublishedFunctions } from './publish/index.ts';
import { stored, twinFunctions, twinIr, unchecked } from './ontology/stored.test-utils.ts';
import {
  ACCOUNT,
  ACTION_TYPE,
  CAMEL_ACTION,
  ENGAGEMENT,
  HIDDEN_RID,
  LINK,
  MEMBER_ACTION_TYPES,
  OBJECT_TYPE,
  SET_ENGAGEMENT_STATUS,
  STRUCT_PROBE,
  twinSplitGrants,
  type Pair,
} from './roles.test-utils.ts';
import { createNodeServer } from './node.ts';
import { claimsOf, NO_ROLE, roleUsers } from './people.test-utils.ts';
import { now } from './tokens.test-utils.ts';
import { stubPublish } from './workos.test-utils.ts';
import { connectV1, mcpSettings, startMcpService, type McpService } from './mcp/mcp.test-utils.ts';
import { closeServer, listenLocal } from './localServer.test-utils.ts';
import { fallibleOf } from './db/promise.test-utils.ts';

const PUBLISH_PATH = '/api/ontology-service/v1/publish';
const QUERY: Pair = { hidden: 'accountSummary', unknown: 'noSuchQuery' };

function versionTwoFunctions(): PublishedFunctions {
  const twin = twinFunctions('0.7.0');

  const accountSummary = {
    locator: { type: 'typescript', typescript: { functionName: QUERY.hidden } },
    inputs: [
      { name: 'client', dataType: { type: 'client', client: {} } },
      { name: 'account', dataType: { type: 'object', object: { objectTypeId: ACCOUNT } } },
    ],
    output: { type: 'single', single: { dataType: { type: 'string', string: {} } } },
    customTypes: {},
    documentation: 'A summary of an Account.',
  } as DiscoveredFunction;

  return { ...twin, discovered: [...twin.discovered, accountSummary] };
}

const NS = 'com.example.twin.';
const DELETE_STRUCT_PROBE = `${NS}delete-struct-probe`;

const MEMBER_LIST = [
  `${NS}create-engagement`,
  `${NS}create-struct-probe`,
  `${NS}delete-engagement`,
  `${NS}delete-struct-probe (deprecated): Deletes a struct probe.`,
  `${NS}set-relationship-action`,
  `${NS}set-struct-probe-relationship`,
];

const ADMIN_LIST = [
  `${NS}close-account-action`,
  `${NS}copy-account-phase`,
  `${NS}create-account`,
  `${NS}create-engagement`,
  `${NS}create-struct-probe`,
  `${NS}delete-account`,
  `${NS}delete-engagement`,
  `${NS}delete-struct-probe (deprecated): Deletes a struct probe.`,
  `${NS}probe-version-check-action`,
  `${NS}set-account-phase`,
  `${NS}set-engagement-status`,
  `${NS}set-relationship-action`,
  `${NS}set-struct-probe-relationship`,
];

const MEMBER_MAP = {
  objectTypes: {
    [ENGAGEMENT]: {
      primaryKey: 'engagementId',
      titleProperty: 'title',
      actionTypes: [`${NS}create-engagement`, `${NS}delete-engagement`],
      queryFunctions: [],
    },
    [STRUCT_PROBE]: {
      description: 'A probe of struct Properties.',
      status: 'DEPRECATED',
      primaryKey: 'probeId',
      titleProperty: 'probeId',
      actionTypes: [
        `${NS}create-struct-probe`,
        `${NS}delete-struct-probe (deprecated): Deletes a struct probe.`,
        `${NS}set-relationship-action`,
        `${NS}set-struct-probe-relationship`,
      ],
      queryFunctions: [],
    },
  },
  linkTypes: {},
  otherActionTypes: [],
  otherQueryFunctions: [],
};

function versionTwo(): OntologyIr {
  const ir = twinIr('0.7.0');
  const structProbe = ir.ontology.objectTypes[STRUCT_PROBE];

  if (!structProbe) throw new Error('The twin 0.7.0 IR has no StructProbe.');

  structProbe.objectType.status = unchecked({ type: 'deprecated', deprecated: {} });

  structProbe.objectType.displayMetadata = unchecked({
    ...structProbe.objectType.displayMetadata,
    description: 'A probe of struct Properties.',
    visibility: 'HIDDEN',
  });

  const deleteStructProbe = ir.ontology.actionTypes[DELETE_STRUCT_PROBE];

  if (!deleteStructProbe) throw new Error('The twin 0.7.0 IR has no delete-struct-probe.');

  deleteStructProbe.actionType.metadata.status = unchecked({ type: 'deprecated', deprecated: {} });

  deleteStructProbe.actionType.metadata.displayMetadata = unchecked({
    ...deleteStructProbe.actionType.metadata.displayMetadata,
    description: 'Deletes a struct probe.',
  });

  return ir;
}

const servers: Server[] = [];
let harness: McpService;
let service: McpService;
let tokens: { admin: string; member: string; claimsAdmin: string; none: string; owner: string; outsider: string };

beforeAll(async () => {
  harness = await startMcpService();

  const users = roleUsers({ ...twinSplitGrants().defaultRoles, owner: [] });

  const server = createNodeServer({
    db: fallibleOf(harness.db),
    directDb: fallibleOf(harness.db),
    settings: mcpSettings,
    keys: harness.issuer.keys,
    users,
    workos: stubPublish(),
  });

  servers.push(server);

  service = { ...harness, url: new URL('/api/mcp', await listenLocal(server)) };

  const ir = versionTwo();

  const response = await fetch(new URL(PUBLISH_PATH, service.baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await service.issuer.github({ exp: now() + 3600 })}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      product: 'twin',
      ir,
      functions: versionTwoFunctions(),
      schemaMigrations: { migrations: [] },
      osdkSet: stored(ir).osdkSet,
      grants: { ...twinSplitGrants(), queryTypes: { [QUERY.hidden]: 'twin:admin' } },
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
    text: "INSERT INTO ontology_1_objects.engagement (engagement_id, account_id, title, amount, status) VALUES ('eng-1', 'acc-1', 'Renewal', 1000, 'open')",
    values: [],
  });

  const exp = now() + 3600;

  tokens = {
    admin: await service.issuer.authkit({ exp, ...claimsOf('admin') }),
    member: await service.issuer.authkit({ exp, ...claimsOf('member') }),
    claimsAdmin: await service.issuer.authkit({ exp, ...claimsOf('member'), role: 'admin' }),
    none: await service.issuer.authkit({ exp, sub: NO_ROLE }),
    outsider: await service.issuer.authkit({ exp, ...claimsOf('outsider') }),
    owner: await service.issuer.authkit({ exp, ...claimsOf('owner') }),
  };
});

afterAll(async () => {
  await Promise.all(servers.map(closeServer));

  await harness?.stop();
});

async function call(token: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const { client } = await connectV1(service, { token });

  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

function masked(result: CallToolResult): unknown {
  const mask = (text: string) => text.replace(/"errorInstanceId":"[^"]*"/g, '"errorInstanceId":"<id>"');
  const content = result.content.map((block) => (block.type === 'text' ? { ...block, text: mask(block.text) } : block));
  const structured = result.structuredContent;

  return {
    ...result,
    content,
    ...(structured && 'errorInstanceId' in structured
      ? { structuredContent: { ...structured, errorInstanceId: '<id>' } }
      : {}),
  };
}

describe('the permissions of an MCP caller are the permissions of the person of its token', () => {
  it('service/authentication#ontology-mcp-tokens service/ontology-mcp#exposure service/ontology-mcp#security: a member token, with no Account, gets a business map with no Account, no Link Type of Account, and no Action Type that names Account', async () => {
    const member = await call(tokens.member, 'describe_object_type', {});

    expect(member.isError).toBeFalsy();
    expect(member.structuredContent).toEqual(MEMBER_MAP);
    expect(JSON.stringify(member.structuredContent)).not.toMatch(/Account|account/);
  });

  it('service/authentication#ontology-mcp-tokens service/ontology-mcp#exposure: an admin token gets each type in the business map, with the HIDDEN StructProbe as deprecated', async () => {
    const admin = (await call(tokens.admin, 'describe_object_type', {})).structuredContent as typeof MEMBER_MAP & {
      objectTypes: Record<string, unknown>;
    };

    expect(Object.keys(admin.objectTypes)).toEqual([ACCOUNT, ENGAGEMENT, STRUCT_PROBE]);
    expect(admin.objectTypes[STRUCT_PROBE]).toEqual(MEMBER_MAP.objectTypes[STRUCT_PROBE]);
    expect(Object.keys(admin.linkTypes)).toEqual(['accountToEngagements']);
  });

  it('service/authentication#access service/ontology-mcp#tools: the member lists no Query Function that takes a hidden Account, and the admin sees accountSummary in describe_query and under Account in the map', async () => {
    expect((await call(tokens.member, 'describe_query', {})).structuredContent).toEqual({ queries: [] });

    expect((await call(tokens.admin, 'describe_query', {})).structuredContent).toEqual({
      queries: ['accountSummary: A summary of an Account.'],
    });

    const admin = (await call(tokens.admin, 'describe_object_type', {})).structuredContent as {
      objectTypes: Record<string, { queryFunctions: string[] }>;
    };

    expect(admin.objectTypes[ACCOUNT]?.queryFunctions).toEqual(['accountSummary: A summary of an Account.']);
  });

  it('service/authentication#ontology-mcp-tokens: a token of the member with the role claim admin gets the member types, so the claim decides nothing', async () => {
    expect((await call(tokens.claimsAdmin, 'describe_object_type', {})).structuredContent).toEqual(MEMBER_MAP);

    expect((await call(tokens.claimsAdmin, 'describe_action', {})).structuredContent).toEqual({
      actionTypes: MEMBER_LIST,
    });
  });

  it.each([
    ['an active membership with no role', () => tokens.none],
    ['the role owner, which holds no permission', () => tokens.owner],
  ])('a token with %s gets an empty business map and an empty list of Action Types', async (_state, token) => {
    expect((await call(token(), 'describe_object_type', {})).structuredContent).toEqual({
      objectTypes: {},
      linkTypes: {},
      otherActionTypes: [],
      otherQueryFunctions: [],
    });

    expect((await call(token(), 'describe_action', {})).structuredContent).toEqual({ actionTypes: [] });
  });

  it('a token of a person with no active membership gets the 403 Default:PermissionDenied of each tool call as a tool result', async () => {
    const result = await call(tokens.outsider, 'describe_object_type', {});

    expect([result.isError, result.structuredContent]).toEqual([
      true,
      {
        errorCode: 'PERMISSION_DENIED',
        errorName: 'Default:PermissionDenied',
        errorInstanceId: expect.any(String),
        parameters: {},
      },
    ]);
  });

  it('service/authentication#ontology-mcp-tokens service/ontology-mcp#exposure: the describe_action list of a member has only its 6 Action Types, the admin list has 13, and each gives delete-struct-probe as deprecated', async () => {
    expect(MEMBER_LIST.map((entry) => entry.split(' ')[0])).toEqual(MEMBER_ACTION_TYPES);

    expect((await call(tokens.member, 'describe_action', {})).structuredContent).toEqual({ actionTypes: MEMBER_LIST });

    expect((await call(tokens.admin, 'describe_action', {})).structuredContent).toEqual({ actionTypes: ADMIN_LIST });
  });

  it('a member loads Engagements, and sees the foreign key accountId', async () => {
    const result = await call(tokens.member, 'load_objects', {
      objectSet: { type: 'base', objectType: ENGAGEMENT },
      select: ['engagementId', 'accountId'],
    });

    expect(result.isError).toBeFalsy();

    expect((result.structuredContent as { data: unknown[] }).data).toEqual([
      {
        __rid: expect.any(String),
        __primaryKey: 'eng-1',
        __apiName: ENGAGEMENT,
        engagementId: 'eng-1',
        accountId: 'acc-1',
      },
    ]);
  });
});

const base = (objectType: string) => ({ type: 'base', objectType });

type Rows = readonly {
  readonly pair: Pair;
  readonly args: (name: string) => Record<string, unknown>;
  readonly errorName: string;
}[];

const ROWS: Record<string, Rows> = {
  describe_object_type: [
    { pair: OBJECT_TYPE, args: (name) => ({ objectType: name }), errorName: 'ObjectTypeNotFound' },
  ],
  describe_action: [
    { pair: ACTION_TYPE, args: (name) => ({ actionType: name }), errorName: 'ActionTypeNotFound' },
    { pair: CAMEL_ACTION, args: (name) => ({ actionType: name }), errorName: 'ActionTypeNotFound' },
  ],
  load_objects: [
    { pair: OBJECT_TYPE, args: (name) => ({ objectSet: base(name) }), errorName: 'ObjectTypeNotFound' },
    {
      pair: LINK,
      args: (name) => ({ objectSet: { type: 'searchAround', objectSet: base(ENGAGEMENT), link: name } }),
      errorName: 'LinkTypeNotFound',
    },
  ],
  aggregate_objects: [
    {
      pair: OBJECT_TYPE,
      args: (name) => ({ objectSet: base(name), aggregation: [{ type: 'count', name: 'count' }], groupBy: [] }),
      errorName: 'ObjectTypeNotFound',
    },
  ],
  get_edit_history: [{ pair: OBJECT_TYPE, args: (name) => ({ objectType: name }), errorName: 'ObjectTypeNotFound' }],
  describe_query: [{ pair: QUERY, args: (name) => ({ query: name }), errorName: 'QueryNotFound' }],
  execute_query: [{ pair: QUERY, args: (name) => ({ query: name, parameters: {} }), errorName: 'QueryNotFound' }],
  apply_action: [
    { pair: ACTION_TYPE, args: (name) => ({ action: name, parameters: {} }), errorName: 'ActionTypeNotFound' },
    { pair: CAMEL_ACTION, args: (name) => ({ action: name, parameters: {} }), errorName: 'ActionTypeNotFound' },
  ],
};

describe('each tool answers a hidden name as an unknown name', () => {
  it('has a row for each tool of tools/list', async () => {
    const { client } = await connectV1(service, { token: tokens.member });

    try {
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(ROWS).sort());
    } finally {
      await client.close();
    }
  });

  for (const [tool, rows] of Object.entries(ROWS)) {
    for (const { pair, args, errorName } of rows) {
      it(`${tool} answers ${pair.hidden} as it answers ${pair.unknown}`, async () => {
        const hidden = await call(tokens.member, tool, args(pair.hidden));

        const unknown = await call(tokens.member, tool, args(pair.unknown));

        expect([unknown.isError, (unknown.structuredContent as { errorName: string }).errorName]).toEqual([
          true,
          errorName,
        ]);

        expect(JSON.stringify(unknown.structuredContent)).toContain(pair.unknown);

        expect(masked(hidden)).toEqual(
          JSON.parse(JSON.stringify(masked(unknown)).replaceAll(pair.unknown, pair.hidden)),
        );

        const text = JSON.stringify(hidden);

        expect(text).not.toContain(HIDDEN_RID);
        expect(text).not.toContain('publishedApiName');

        expect(text.includes(SET_ENGAGEMENT_STATUS)).toBe(pair === ACTION_TYPE);
      });
    }
  }
});
