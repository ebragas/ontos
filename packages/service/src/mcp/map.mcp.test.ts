import type { OntologyIr } from '@osdk/client.unstable';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stored, twinFunctions, twinGrants, twinIr, unchecked } from '../ontology/stored.test-utils.ts';
import { claimsOf } from '../people.test-utils.ts';
import { now } from '../tokens.test-utils.ts';
import { connectV1, startMcpService, type McpService } from './mcp.test-utils.ts';

const NS = 'com.example.twin.';
const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;
const LINK_IR_KEY = 'account-to-engagements';
const LINK_API_NAME = 'accountToEngagements';

let service: McpService;
let adminToken: string;

beforeAll(async () => {
  service = await startMcpService();

  adminToken = await service.issuer.authkit({ exp: now() + 3600, ...claimsOf('admin') });
});

afterAll(() => service?.stop());

interface BusinessMap {
  readonly objectTypes: Record<string, { readonly description?: string; readonly actionTypes: readonly string[] }>;
  readonly linkTypes: Record<string, { readonly description?: string; readonly sides: readonly unknown[] }>;
  readonly otherActionTypes: readonly string[];
  readonly detail?: string;
}

async function businessMap(): Promise<{ map: BusinessMap; length: number }> {
  const { client } = await connectV1(service, { token: adminToken });

  try {
    const result = (await client.callTool({ name: 'describe_object_type', arguments: {} })) as CallToolResult;

    expect(result.isError).toBeFalsy();

    const [block] = result.content;
    const text = block?.type === 'text' ? block.text : '';
    const map = JSON.parse(text) as BusinessMap;

    expect(map).toEqual(result.structuredContent);

    return { map, length: text.length };
  } finally {
    await client.close();
  }
}

async function publish(change: (ir: OntologyIr) => void): Promise<void> {
  const ir = twinIr('0.7.0');

  change(ir);

  const response = await fetch(new URL('/api/ontology-service/v1/publish', service.baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await service.issuer.github({ exp: now() + 3600 })}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      product: 'twin',
      ir,
      functions: twinFunctions('0.7.0'),
      schemaMigrations: { migrations: [] },
      osdkSet: stored(ir).osdkSet,
      grants: twinGrants('0.7.0'),
      validateOnly: false,
    }),
  });

  if (response.status !== 200) throw new Error(`The publish gave ${response.status}: ${await response.text()}`);
}

function describeAccount(ir: OntologyIr, description: string): void {
  const account = ir.ontology.objectTypes[ACCOUNT];

  if (!account) throw new Error('The twin 0.7.0 IR has no Account.');

  account.objectType.displayMetadata = unchecked({ ...account.objectType.displayMetadata, description });
}

function describeLink(ir: OntologyIr, description: string): void {
  const link = ir.ontology.linkTypes[LINK_IR_KEY];

  if (!link) throw new Error(`The twin 0.7.0 IR has no ${LINK_IR_KEY}.`);

  link.linkType = unchecked({ ...link.linkType, description });
}

function describeActions(ir: OntologyIr): void {
  for (const { actionType } of Object.values(ir.ontology.actionTypes)) {
    actionType.metadata.displayMetadata = unchecked({
      ...actionType.metadata.displayMetadata,
      description: `${'a'.repeat(2000)}\nThe second line.`,
    });
  }
}

const TWIN_TYPES = {
  objectTypes: [ACCOUNT, ENGAGEMENT, STRUCT_PROBE],
  linkTypes: [LINK_API_NAME],
  actionTypes: [
    `${NS}close-account-action`,
    `${NS}copy-account-phase`,
    `${NS}create-account`,
    `${NS}create-engagement`,
    `${NS}create-struct-probe`,
    `${NS}delete-account`,
    `${NS}delete-engagement`,
    `${NS}delete-struct-probe`,
    `${NS}probe-version-check-action`,
    `${NS}set-account-phase`,
    `${NS}set-engagement-status`,
    `${NS}set-relationship-action`,
    `${NS}set-struct-probe-relationship`,
  ],
};

function typesOf(map: BusinessMap): typeof TWIN_TYPES {
  const actionTypes = new Set([
    ...Object.values(map.objectTypes).flatMap((objectType) => objectType.actionTypes),
    ...map.otherActionTypes,
  ]);

  return {
    objectTypes: Object.keys(map.objectTypes),
    linkTypes: Object.keys(map.linkTypes),
    actionTypes: [...actionTypes].sort(),
  };
}

describe('service/ontology-mcp#tools: the business map', () => {
  it('service/ontology-mcp#tools/a491079d: the map after a publish shows the new version', async () => {
    await publish((ir) => describeAccount(ir, 'Version A of the Account description.'));

    expect((await businessMap()).map.objectTypes[ACCOUNT]?.description).toBe('Version A of the Account description.');

    await publish((ir) => describeAccount(ir, 'Version B of the Account description.'));

    expect((await businessMap()).map.objectTypes[ACCOUNT]?.description).toBe('Version B of the Account description.');
  });

  it('service/ontology-mcp#tools/573edf0d: a map over 25,000 characters gives each Action Type by API name only, keeps each type, and says which calls give the detail', async () => {
    await publish((ir) => {
      describeActions(ir);

      describeLink(ir, 'The Engagements of an Account.');
    });

    const { map, length } = await businessMap();

    expect(length).toBeLessThanOrEqual(25_000);
    expect(typesOf(map)).toEqual(TWIN_TYPES);
    expect(map.linkTypes[LINK_API_NAME]?.description).toBe('The Engagements of an Account.');

    expect(map.detail).toBe(
      'This map leaves out the descriptions of the Action Types. describe_object_type with an objectType and describe_action with an actionType give the detail.',
    );
  });

  it('service/ontology-mcp#tools/573edf0d: a map still over 25,000 characters with the Action Types by API name also leaves out the Link Type descriptions, and keeps each type', async () => {
    await publish((ir) => {
      describeActions(ir);

      describeLink(ir, 'l'.repeat(26_000));
    });

    const { map, length } = await businessMap();

    expect(length).toBeLessThanOrEqual(25_000);
    expect(typesOf(map)).toEqual(TWIN_TYPES);

    expect(map.linkTypes[LINK_API_NAME]).toEqual({
      sides: [
        { objectType: ACCOUNT, link: 'engagements', cardinality: 'MANY' },
        { objectType: ENGAGEMENT, link: 'account', cardinality: 'ONE' },
      ],
    });

    expect(map.detail).toBe(
      'This map leaves out the descriptions of the Action Types and the Link Types. describe_object_type with an objectType and describe_action with an actionType give the detail.',
    );
  });
});
