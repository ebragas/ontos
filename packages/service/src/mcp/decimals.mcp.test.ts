import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  addDecimalProbe,
  CREATE_DECIMAL_PROBE,
  DECIMAL_PROBE,
  EDIT_COUNTS,
  numberPaths,
} from '../decimalProbe.test-utils.ts';
import { grantsOf, irOf, NS, ONTOLOGY_RID, twinBlock } from '../ontology/stored.test-utils.ts';
import { claimsOf } from '../people.test-utils.ts';
import { now } from '../tokens.test-utils.ts';
import { connectV1, startMcpService, type McpService } from './mcp.test-utils.ts';

const TOOLS = 'service/ontology-mcp#tools';

let service: McpService;
let applied: CallToolResult;

beforeAll(async () => {
  const ir = addDecimalProbe(irOf(twinBlock('0.7.0', `${NS}Account`)));

  service = await startMcpService({ ir, grants: grantsOf(ir) });

  applied = await call('apply_action', {
    action: CREATE_DECIMAL_PROBE,
    parameters: {
      accountId: 'dec-1',
      name: 'Probe',
      amount: 1299.9,
      amounts: [1.5, 2],
      line: { sku: 'A-1', unitPrice: 12.5 },
    },
  });
});

afterAll(() => service?.stop());

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const { client } = await connectV1(service, {
    token: await service.issuer.authkit({ exp: now() + 3600, ...claimsOf('admin') }),
  });

  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

async function restAnswer(path: string, body: unknown): Promise<unknown> {
  const token = await service.issuer.workos({ exp: now() + 3600, ...claimsOf('admin') });

  const response = await fetch(`${service.baseUrl}/api/v2/ontologies/${ONTOLOGY_RID}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  expect(response.status).toBe(200);

  return response.json();
}

function checkedContent(result: CallToolResult): unknown {
  expect(result.isError).toBeFalsy();
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }]);

  return result.structuredContent;
}

const PADDED = { amount: '1299.90', amounts: ['1.50', '2.00'], line: { sku: 'A-1', unitPrice: '12.5000' } };

const LOAD = {
  objectSet: { type: 'base', objectType: DECIMAL_PROBE },
  select: ['accountId', 'amount', 'amounts', 'line'],
};

it(`${TOOLS}: apply_action gives no Decimal, and no JSON number except the edit counts`, () => {
  const answer = checkedContent(applied);

  expect(answer).toMatchObject({
    edits: { edits: [{ type: 'addObject', primaryKey: 'dec-1', objectType: DECIMAL_PROBE }] },
  });

  expect(numberPaths(answer)).toEqual(EDIT_COUNTS);
});

it(`${TOOLS}: load_objects gives each scalar, array, and struct Decimal as the padded string of loadObjects`, async () => {
  const objects = checkedContent(await call('load_objects', LOAD));

  expect(objects).toMatchObject({ data: [{ accountId: 'dec-1', ...PADDED }] });

  expect(objects).toEqual(await restAnswer('objectSets/loadObjects', { ...LOAD, pageSize: 200 }));
});

it(`${TOOLS}: aggregate_objects gives sum, avg, min, and max of a Decimal as the exact strings of aggregate`, async () => {
  const request = {
    objectSet: { type: 'base', objectType: DECIMAL_PROBE },
    aggregation: ['sum', 'avg', 'min', 'max'].map((type) => ({ type, field: 'amount', name: type })),
  };

  const metrics = checkedContent(await call('aggregate_objects', request));

  expect(metrics).toMatchObject({
    data: [{ metrics: ['sum', 'avg', 'min', 'max'].map((name) => ({ name, value: '1299.90' })) }],
  });

  expect(metrics).toEqual(await restAnswer('objectSets/aggregate', { ...request, groupBy: [] }));
});

it(`${TOOLS}: get_edit_history gives each Decimal of the entry as the padded string of Object Edit History`, async () => {
  const history = checkedContent(
    await call('get_edit_history', { objectType: DECIMAL_PROBE, objectPrimaryKey: { accountId: 'dec-1' } }),
  );

  expect(history).toMatchObject({ data: [{ edit: { type: 'createEdit', properties: PADDED } }] });

  expect(history).toEqual(
    await restAnswer(`objectTypes/${DECIMAL_PROBE}/editsHistory`, { objectPrimaryKey: { accountId: 'dec-1' } }),
  );
});
