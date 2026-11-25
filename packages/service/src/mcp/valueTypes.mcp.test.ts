import { readFileSync } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OntologyIr, StringTypeDataConstraints } from '@osdk/client.unstable';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actionType, addRule, parameterValue } from '../actions/actions.test-utils.ts';
import { grantsOf, irOf, NS, stringProperty, unchecked } from '../ontology/stored.test-utils.ts';
import { claimsOf } from '../people.test-utils.ts';
import { now } from '../tokens.test-utils.ts';
import { connectV1, startMcpService, type McpService } from './mcp.test-utils.ts';

const TASK = `${NS}Task`;
const CREATE_TASK = `${NS}create-task`;
const PACKAGE = 'com.example.twin';

type StringRule = readonly [body: StringTypeDataConstraints, message?: string];

const STRING_VALUE_TYPES: Record<string, readonly StringRule[]> = {
  sku: [
    [{ type: 'length', length: { minSize: 6, maxSize: 12 } }],
    [
      { type: 'regex', regex: { regexPattern: '[A-Z]{3}-\\d+', usePartialMatch: false } },
      'A SKU is 3 capitals, a dash, and digits.',
    ],
  ],
  code: [[{ type: 'regex', regex: { regexPattern: 'x', usePartialMatch: true } }]],
  ref: [[{ type: 'isUuid', isUuid: {} }]],
  shout: [[{ type: 'length', length: { minSize: 1, maxSize: 9 } }, 'Say "hi".\nThen stop.']],
};

const failure = (message: string | undefined) => (message === undefined ? {} : { failureMessage: { message } });

function stringValueType(apiName: string, rules: readonly StringRule[]): { valueType: object; property: object } {
  const displayMetadata = { displayName: apiName, description: '' };

  return {
    valueType: {
      metadata: { apiName, packageNamespace: PACKAGE, displayMetadata, status: { type: 'active', active: {} } },
      versions: [
        {
          version: '1.0.0',
          baseType: { type: 'string', string: {} },
          constraints: rules.map(([body, message]) => ({
            constraint: { constraint: { type: 'string', string: body }, ...failure(message) },
          })),
          exampleValues: [],
        },
      ],
    },
    property: {
      ...stringProperty(apiName),
      dataConstraints: {
        propertyTypeConstraints: rules.map(([body, message]) => ({
          constraints: { type: 'string', string: body },
          ...failure(message),
        })),
      },
      valueType: { apiName, version: '1.0.0', packageNamespace: PACKAGE, displayMetadata },
    },
  };
}

function testIr(): OntologyIr {
  const source = JSON.parse(
    readFileSync(new URL('../../twin/ir/value-types.json', import.meta.url), 'utf8'),
  ) as OntologyIr;

  const task = source.ontology.objectTypes[TASK];

  if (!task) throw new Error('The value types IR has no Task.');

  const added = Object.entries(STRING_VALUE_TYPES).map(
    ([apiName, rules]) => [apiName, stringValueType(apiName, rules)] as const,
  );

  for (const [apiName, { property }] of added) task.objectType.propertyTypes[apiName] = unchecked(property);

  task.entityMetadata = unchecked({ ...task.entityMetadata, arePatchesEnabled: true });

  const ir = irOf(task);

  ir.valueTypes = unchecked({
    valueTypes: [...source.valueTypes.valueTypes, ...added.map(([, { valueType }]) => valueType)],
  });

  const string = {
    type: { type: 'string', string: {} },
    allowedValues: { type: 'text', text: { type: 'text', text: {} } },
    required: { type: 'notRequired', notRequired: {} },
  };

  ir.ontology.actionTypes[CREATE_TASK] = actionType(CREATE_TASK, unchecked({ taskId: string, status: string }), [
    addRule(TASK, { taskId: parameterValue('taskId'), status: parameterValue('status') }),
  ]);

  return ir;
}

let service: McpService;

beforeAll(async () => {
  const ir = testIr();

  service = await startMcpService({ ir, grants: grantsOf(ir) });
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

describe('service/ontology-mcp#tools: describe_object_type with a value type', () => {
  it('service/ontology-mcp#tools: gives each Property with a value type its header line and 1 line for each constraint, with its failure message', async () => {
    const result = await call('describe_object_type', { objectType: TASK });

    expect(result.isError).toBeFalsy();

    const { properties } = result.structuredContent as { properties: Record<string, { notes?: string[] }> };

    expect(Object.fromEntries(Object.entries(properties).map(([apiName, entry]) => [apiName, entry.notes]))).toEqual({
      taskId: undefined,
      status: [
        'Value type taskStatus, version 1.1.0.',
        'Each value is one of "open", "done". When it does not: "Use open or done."',
      ],
      budget: ['Value type money, version 1.0.0, deprecated.', 'Each value is at least "0" and at most "1000000".'],
      labels: [
        'Value type tags, version 2.0.0.',
        'Each value is a list of 1 to 5 elements, with no element 2 times, and each element matches the regex [a-z]+ in full. When it does not: "Use 1 to 5 lowercase tags."',
      ],
      sku: [
        'Value type sku, version 1.0.0.',
        'Each value has 6 to 12 characters.',
        'Each value matches the regex [A-Z]{3}-\\d+ in full. When it does not: "A SKU is 3 capitals, a dash, and digits."',
      ],
      code: ['Value type code, version 1.0.0.', 'Each value contains a match of the regex x.'],
      ref: ['Value type ref, version 1.0.0.', 'Each value is a UUID.'],
      shout: expect.any(Array),
    });
  });
});

describe('service/ontology-mcp#errors: apply_action with a value that a value type refuses', () => {
  it('service/ontology-mcp#errors: gives the error of the write check in the tool error, with the same userErrorMessage and builderErrorMessage', async () => {
    const result = await call('apply_action', { action: CREATE_TASK, parameters: { taskId: 't-1', status: 'bogus' } });

    expect(result.isError).toBe(true);

    expect(result.structuredContent).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'ApplyActionFailed',
      errorInstanceId: expect.any(String),
      parameters: {
        originalErrorName: 'Ontos:InvalidActionPropertyFormat',
        objectType: TASK,
        property: 'status',
        userErrorMessage: 'Use open or done.',
        builderErrorMessage: `The value of Property status of Object Type ${TASK} breaks the value type taskStatus: each value is one of "open", "done".`,
      },
    });

    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
  });
});

describe('service/ontology-mcp#tools: a failure message with a quote and a line break', () => {
  it('service/ontology-mcp#tools: gives exactly 1 notes line for the constraint', async () => {
    const result = await call('describe_object_type', { objectType: TASK });

    const { properties } = result.structuredContent as { properties: Record<string, { notes?: string[] }> };

    expect(properties.shout?.notes).toEqual([
      'Value type shout, version 1.0.0.',
      String.raw`Each value has 1 to 9 characters. When it does not: "Say \"hi\".\nThen stop."`,
    ]);
  });
});
