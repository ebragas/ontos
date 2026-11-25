import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandleInput, Settings } from './index.ts';
import {
  errorAnswer,
  ONTOLOGY_RID,
  rowsOf,
  startActions,
  type ActionsService,
  type Answer,
} from '../actions/actions.test-utils.ts';
import { grantsOf } from '../ontology/stored.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import { AUTHKIT_DOMAIN, createTestIssuer } from '../tokens.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';
import {
  FUNCTIONS,
  ROW,
  ROW_PROBE,
  rowProbeIr,
  SOURCE,
  structListOntology,
} from '../functions/structList.test-utils.ts';
import { actionOf, withFunctions, type TestField, type TestInput } from '../functions/functions.test-utils.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';

const APPLY_ROW_PROBES = actionOf('applyRowProbes');

let service: ActionsService;

beforeAll(async () => {
  await import('./index.ts');

  const { ir, functions } = await structListOntology();

  service = await startActions(ir, functions);
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

const VALIDATE_ONLY = { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' };
const EXECUTE_ALL = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };
const MODES = [VALIDATE_ONLY, EXECUTE_ALL];

function apply(parameters: Record<string, unknown>, options: object = EXECUTE_ALL, apiName = 'applyRowProbes') {
  return service.apply(actionOf(apiName), { parameters, options });
}

async function expectEachMode(parameters: Record<string, unknown>, expected: Answer): Promise<void> {
  for (const options of MODES)
    expect(errorAnswer(await apply({ ...parameters, reportId: 'report' }, options))).toEqual(expected);

  expect(await rowsOf(service.db, ROW_PROBE, 'row_id')).toEqual([]);
}

async function reported(rowId: string): Promise<unknown> {
  const rows = (await rowsOf(service.db, ROW_PROBE, 'row_id')) as { row_id: string; label: string }[];

  const row = rows.find((r) => r.row_id === rowId);

  if (!row) throw new Error(`The Function created no RowProbe ${rowId}.`);

  return JSON.parse(row.label);
}

const row = (rowId: string, op = 'noop', fields: Record<string, unknown> = {}) => ({
  rowId,
  label: `label of ${rowId}`,
  count: 1,
  op,
  ...fields,
});

const invalid = (parameters: Record<string, unknown>): Answer => ({
  status: 400,
  body: { errorCode: 'INVALID_ARGUMENT', errorName: 'InvalidParameterValue', parameters },
});

const field = (result: 'VALID' | 'INVALID', required: boolean) => ({ result, evaluatedConstraints: [], required });

const entry = (label: 'VALID' | 'INVALID' = 'VALID') => ({
  type: 'struct',
  structFields: {
    rowId: field('VALID', true),
    label: field(label, true),
    count: field('VALID', true),
    note: field('VALID', false),
    op: field('VALID', true),
  },
});

const NULL_LIST: Answer = {
  status: 400,
  body: {
    errorCode: 'INVALID_ARGUMENT',
    errorName: 'ApplyActionFailed',
    parameters: {
      originalErrorName: 'Ontos:SingletonValueForListParameter',
      userErrorMessage: 'The Action could not apply because of an invalid list parameter.',
      builderErrorMessage: 'A list parameter received a single value instead of a list.',
    },
  },
};

const ROWS_METADATA = {
  displayName: 'Rows',
  dataType: {
    type: 'array',
    subType: {
      type: 'struct',
      fields: [
        { name: 'rowId', fieldType: { type: 'string' }, required: true },
        { name: 'label', fieldType: { type: 'string' }, required: true },
        { name: 'count', fieldType: { type: 'integer' }, required: true },
        { name: 'note', fieldType: { type: 'string' }, required: false },
        { name: 'op', fieldType: { type: 'string' }, required: true },
      ],
    },
  },
  required: false,
  typeClasses: [],
};

const ACTION_TYPE_PATH = `/api/v2/ontologies/${ONTOLOGY_RID}/actionTypes/${APPLY_ROW_PROBES}`;

describe('the metadata of a struct list parameter', () => {
  it('ontology/action-types/action-types#parameters: the struct list data type, with the fields in declaration order, after a publish and after a cold start', async () => {
    const answer = await service.call('GET', ACTION_TYPE_PATH);

    expect(answer.status).toBe(200);

    expect((JSON.parse(answer.text) as { parameters: Record<string, unknown> }).parameters['rows']).toEqual(
      ROWS_METADATA,
    );

    vi.resetModules();

    const { handle } = await import('./index.ts');

    const settings: Settings = {
      productRid: ONTOLOGY_RID,
      environment: 'test',
      auth: {
        workosClientId: 'actions',
        baseUrl: 'http://localhost',
        app: { repository: 'example/twin', environment: 'publish' },
      },
      authkitDomain: AUTHKIT_DOMAIN,
      mcp: true,
    };

    const issuer = await createTestIssuer(settings.auth);

    const { ir } = await structListOntology();

    const input: HandleInput = {
      db: fallibleOf(service.db),
      directDb: fallibleOf(service.db),
      settings,
      keys: issuer.keys,
      users: roleUsers(grantsOf(ir).defaultRoles),
      workos: stubPublish(),
    };

    const response = await handle(
      new Request(`http://localhost${ACTION_TYPE_PATH}`, {
        headers: { authorization: `Bearer ${await issuer.workos()}` },
      }),
      input,
    );

    expect(response.status).toBe(200);

    expect(((await response.json()) as { parameters: Record<string, unknown> }).parameters['rows']).toEqual(
      ROWS_METADATA,
    );

    const applied = await handle(
      new Request(`http://localhost/api/v2/ontologies/${ONTOLOGY_RID}/actions/${APPLY_ROW_PROBES}/apply`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await issuer.workos()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ parameters: { rows: [row('n1')] }, options: VALIDATE_ONLY }),
      }),
      input,
    );

    expect(((await applied.json()) as { validation: unknown }).validation).toEqual({
      result: 'VALID',
      submissionCriteria: [],
      parameters: {
        reportId: field('VALID', false),
        rows: {
          result: 'VALID',
          evaluatedConstraints: [{ type: 'array', entries: [entry()] }, { type: 'arraySize' }],
          required: false,
        },
      },
    });
  });
});

describe('the value of a struct list', () => {
  it('ontology/action-types/action-types#parameters: a single struct in place of the list gets 400 with the base type Struct', async () => {
    const single = row('single');

    await expectEachMode(
      { rows: single },
      invalid({ parameterBaseType: 'Struct', parameterId: 'rows', parameterValue: single }),
    );
  });

  it('ontology/action-types/action-types#parameters: a value that is not a JSON object or array gets 400 with the base type Struct', async () => {
    await expectEachMode(
      { rows: 'x' },
      invalid({ parameterBaseType: 'Struct', parameterId: 'rows', parameterValue: 'x' }),
    );
  });

  it('ontology/action-types/action-types#parameters: rows: null gets 400 ApplyActionFailed in both modes, and the Function does not run', async () => {
    await expectEachMode({ rows: null }, NULL_LIST);
  });
});

describe('the check of each row', () => {
  it('ontology/action-types/action-types#parameters: the first bad row wins', async () => {
    const badMissing = { rowId: 'b0', count: 1, op: 'noop' };

    await expectEachMode(
      { rows: [badMissing, row('b1', 'noop', { count: 'seven' })] },
      invalid({ parameterId: 'rows', parameterValue: badMissing }),
    );

    await expectEachMode(
      { rows: [row('b0', 'noop', { count: 'seven' }), { rowId: 'b1' }] },
      invalid({ parameterBaseType: 'Integer', parameterId: 'rows.count', parameterValue: 'seven' }),
    );
  });

  it('ontology/action-types/action-types#parameters: label null in row 0 and count seven in row 1 give the 400 of row 1', async () => {
    await expectEachMode(
      { rows: [row('n0', 'noop', { label: null }), row('n1', 'noop', { count: 'seven' })] },
      invalid({ parameterBaseType: 'Integer', parameterId: 'rows.count', parameterValue: 'seven' }),
    );
  });

  it('ontology/action-types/action-types#parameters: a bad element gets 400 with the element and no base type', async () => {
    for (const bad of [null, 'x', { rowId: 'm1', count: 1, op: 'noop' }, { ...row('u1'), extra: 1 }]) {
      await expectEachMode({ rows: [bad] }, invalid({ parameterId: 'rows', parameterValue: bad }));
    }
  });

  it('ontology/action-types/action-types#parameters: a field value of the wrong base type gets 400 with rows.<field> and the base type of the field', async () => {
    await expectEachMode(
      { rows: [row('t1', 'noop', { count: 'seven' })] },
      invalid({ parameterBaseType: 'Integer', parameterId: 'rows.count', parameterValue: 'seven' }),
    );

    await expectEachMode(
      { rows: [row('t2', 'noop', { label: 42 })] },
      invalid({ parameterBaseType: 'String', parameterId: 'rows.label', parameterValue: 42 }),
    );
  });
});

describe('the validation result of a struct list', () => {
  it('ontology/action-types/action-types#parameters: 2 good rows give 1 struct entry each, and then a bare arraySize', async () => {
    const answer = await apply({ rows: [row('g1'), row('g2')] }, VALIDATE_ONLY);

    expect(answer.status).toBe(200);

    expect(answer.body).toEqual({
      validation: {
        result: 'VALID',
        submissionCriteria: [],
        parameters: {
          reportId: field('VALID', false),
          rows: {
            result: 'VALID',
            evaluatedConstraints: [{ type: 'array', entries: [entry(), entry()] }, { type: 'arraySize' }],
            required: false,
          },
        },
      },
    });
  });

  it('ontology/action-types/action-types#parameters: label null gives INVALID in the entry of its row, and the Function does not run', async () => {
    for (const options of MODES) {
      const answer = await apply({ rows: [row('n1', 'noop', { label: null })], reportId: 'r-null' }, options);

      expect(answer.status).toBe(200);

      expect(answer.body).toEqual({
        validation: {
          result: 'INVALID',
          submissionCriteria: [],
          parameters: {
            reportId: field('VALID', false),
            rows: {
              result: 'INVALID',
              evaluatedConstraints: [{ type: 'array', entries: [entry('INVALID')] }, { type: 'arraySize' }],
              required: false,
            },
          },
        },
      });
    }

    expect(await rowsOf(service.db, ROW_PROBE, 'row_id')).toEqual([]);
  });

  it('ontology/action-types/action-types#parameters, ontology/functions/functions#function-backed-actions: an omitted rows, an omitted rows?, and rows: [] give entries: [], and the Function gets []', async () => {
    for (const [reportId, apiName, parameters] of [
      ['omitted', 'applyRowProbes', {}],
      ['optional', 'applyOptionalRows', {}],
      ['empty', 'applyRowProbes', { rows: [] }],
    ] as const) {
      expect((await apply(parameters, VALIDATE_ONLY, apiName)).body).toMatchObject({
        validation: {
          result: 'VALID',
          parameters: {
            rows: {
              result: 'VALID',
              evaluatedConstraints: [{ type: 'array', entries: [] }, { type: 'arraySize' }],
              required: false,
            },
          },
        },
      });

      expect((await apply({ ...parameters, reportId }, EXECUTE_ALL, apiName)).status).toBe(200);

      expect(await reported(reportId)).toEqual({ rows: 0, note: [] });
    }
  });
});

describe('the row limit of a struct list', () => {
  const rows = (count: number, op = 'noop') =>
    Array.from({ length: count }, (_, i) => ({ rowId: `p-sl-m-${i}`, label: 'x', count: i, op }));

  const OVER_LIMIT = {
    result: 'INVALID',
    evaluatedConstraints: [{ type: 'array', entries: [] }, { type: 'arraySize' }],
    required: false,
  };

  it('ontology/action-types/action-types#parameters: 10,000 rows pass, 10,001 rows give INVALID with no entry, and a bad row at index 10,000 gives its 400', async () => {
    expect((await apply({ rows: rows(10_000) })).body).toMatchObject({
      validation: { result: 'VALID', parameters: {} },
    });

    for (const op of ['noop', 'create']) {
      for (const options of MODES) {
        const answer = await apply({ rows: rows(10_001, op), reportId: 'report' }, options);

        expect(answer.status).toBe(200);

        expect(answer.body).toEqual({
          validation: {
            result: 'INVALID',
            submissionCriteria: [],
            parameters: { reportId: field('VALID', false), rows: OVER_LIMIT },
          },
        });
      }
    }

    expect(await rowsOf(service.db, ROW_PROBE, 'row_id')).toEqual([]);

    const bad = [...rows(10_000), { rowId: 'p-sl-m-10000', label: 'x', count: 'seven', op: 'noop' }];

    await expectEachMode(
      { rows: bad },
      invalid({ parameterBaseType: 'Integer', parameterId: 'rows.count', parameterValue: 'seven' }),
    );
  });
});

describe('what the Function gets', () => {
  it('ontology/functions/functions#function-backed-actions: note null passes, and the Function gets the row with no note key', async () => {
    const answer = await apply(
      { reportId: 'p-sl-r-g2', rows: [row('g1', 'noop', { note: null }), row('g2', 'noop', { note: 'hello' })] },
      EXECUTE_ALL,
    );

    expect(answer.status).toBe(200);

    expect(await reported('p-sl-r-g2')).toEqual({ rows: 2, note: ['absent', 'string'] });
  });

  it('ontology/functions/functions#function-backed-actions: reportTypes gets each field as the JSON value of the request', async () => {
    const answer = await apply(
      { reportId: 'types', rows: [{ amount: 1.5, flag: true, postedOn: '2026-11-15', at: '2026-11-15T12:00:00Z' }] },
      EXECUTE_ALL,
      'reportTypes',
    );

    expect(answer.status).toBe(200);

    expect(await reported('types')).toEqual([
      {
        amount: 'number:1.5',
        flag: 'boolean:true',
        postedOn: 'string:"2026-11-15"',
        at: 'string:"2026-11-15T12:00:00Z"',
      },
    ]);
  });

  it('ontology/functions/functions#function-backed-actions: VALIDATE_ONLY of an update row for a missing key gives 404 ObjectNotFound', async () => {
    const answer = await apply({ rows: [row('p-sl-absent', 'update')] }, VALIDATE_ONLY);

    expect(errorAnswer(answer)).toEqual({
      status: 404,
      body: { errorCode: 'NOT_FOUND', errorName: 'ObjectNotFound', parameters: { primaryKey: {} } },
    });
  });

  it('ontology/functions/functions#function-backed-actions: a create row of a key that exists gives VALID in VALIDATE_ONLY and 409 in execute', async () => {
    expect((await apply({ rows: [{ rowId: 'p-sl-c7', label: 'first create', count: 1, op: 'create' }] })).status).toBe(
      200,
    );

    const validated = await apply(
      { rows: [{ rowId: 'p-sl-c7', label: 'second create', count: 2, op: 'create' }] },
      VALIDATE_ONLY,
    );

    expect(validated.status).toBe(200);
    expect((validated.body as { validation?: { result?: string } }).validation?.result).toBe('VALID');

    const executed = await apply(
      { rows: [{ rowId: 'p-sl-c7', label: 'second create', count: 2, op: 'create' }] },
      EXECUTE_ALL,
    );

    expect(executed.status).toBe(409);
  });
});

describe('a struct list over the Ontology MCP', () => {
  it('service/ontology-mcp#tools: describe_action gives the struct list data type, and apply_action takes the rows', async () => {
    const described = (await service.tool('describe_action', { actionType: APPLY_ROW_PROBES })).body as {
      result: { structuredContent: { parameters: Record<string, unknown> } };
    };

    expect(described.result.structuredContent.parameters['rows']).toEqual({
      dataType: ROWS_METADATA.dataType,
      required: ROWS_METADATA.required,
    });

    const applied = (
      await service.applyOverMcp(APPLY_ROW_PROBES, {
        rows: [
          { rowId: 'm1', label: 'one', count: 1, op: 'create' },
          { rowId: 'm2', label: 'two', count: 2, op: 'create' },
        ],
      })
    ).body as {
      result: {
        isError?: boolean;
        structuredContent: { validation: { result: string }; edits: { edits: { type: string; primaryKey: string }[] } };
      };
    };

    expect(applied.result.isError).toBeUndefined();
    expect(applied.result.structuredContent.validation.result).toBe('VALID');

    expect(applied.result.structuredContent.edits.edits.map(({ type, primaryKey }) => [type, primaryKey])).toEqual([
      ['addObject', 'm1'],
      ['addObject', 'm2'],
    ]);

    const nullList = (await service.applyOverMcp(APPLY_ROW_PROBES, { rows: null })).body as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    };

    expect(nullList.result.isError).toBe(true);

    const { errorInstanceId, ...error } = nullList.result.structuredContent;

    expect(errorInstanceId).toEqual(expect.any(String));
    expect(error).toEqual(NULL_LIST.body);
  });
});

describe('a struct list on an active Action Type', () => {
  const withNames = (names: TestInput, fields: readonly TestField[] = ROW) =>
    withFunctions(
      [
        ...FUNCTIONS.map((fn) =>
          fn.apiName === 'applyRowProbes'
            ? { ...fn, inputs: [{ name: 'rows', type: 'structList', fields } as const, ...fn.inputs.slice(1)] }
            : fn,
        ),
        { apiName: 'applyNames', inputs: [names], edits: [ROW_PROBE] },
      ],
      `${SOURCE}\nfunctions.applyNames = async () => [];`,
      rowProbeIr(),
    );

  const refused = (actionType: string) => ({
    errorName: 'Default:InvalidArgument',
    parameters: {
      change: `Change the type of parameter rows of Action Type ${actionType}`,
      status: 'active',
      requiredStatus: 'deprecated',
    },
  });

  async function refusal(next: ReturnType<typeof withNames>): Promise<unknown> {
    const { ir, functions } = await next;

    const error: unknown = await service.publish(ir, functions).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    const match = /^The publish gave 400: (.*)$/s.exec(error instanceof Error ? error.message : '');

    if (!match?.[1]) throw new Error(`The publish was not refused with 400: ${String(error)}`);

    const { errorName, parameters } = JSON.parse(match[1]) as { errorName: string; parameters: unknown };

    return { errorName, parameters };
  }

  it('ontology/action-types/action-types#statuses: rows: string[] to rows: Row[], and a new field of Row, each get 400 Default:InvalidArgument', async () => {
    const { ir, functions } = await withNames({ name: 'rows', type: 'stringList' });

    await service.publish(ir, functions);

    expect(await refusal(withNames({ name: 'rows', type: 'structList', fields: ROW }))).toEqual(
      refused(actionOf('applyNames')),
    );

    expect(
      await refusal(
        withNames({ name: 'rows', type: 'stringList' }, [...ROW, { name: 'extra', type: 'string', required: false }]),
      ),
    ).toEqual(refused(APPLY_ROW_PROBES));
  });
});
