import { readFileSync } from 'node:fs';
import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actionOf, ScriptedFunctions, withFunctions } from '../functions/functions.test-utils.ts';
import type { JsonValue } from '../ontology/index.ts';
import { unchecked } from '../ontology/stored.test-utils.ts';
import {
  actionType,
  addRule,
  errorAnswer,
  insertObjects,
  modifyRule,
  NS,
  parameterValue,
  rowsOf,
  startActions,
  twinIr,
  type ActionsService,
} from './actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const TASK = `${NS}Task`;
const CREATE_TASK = `${NS}create-task`;
const MODIFY_TASK = `${NS}modify-task`;
const CREATE_TWO_TASKS = `${NS}create-two-tasks`;
const CREATE_PICKED_TASK = `${NS}create-picked-task`;
const COPY_LABELS = `${NS}copy-labels`;
const SET_LABELS_TWICE = `${NS}set-labels-twice`;
const SCRIPTED_ACTION = actionOf('scripted');

const TEXT = { type: 'text', text: { type: 'text', text: {} } };
const RANGE = { type: 'range', range: { type: 'range', range: {} } };
const REQUIRED = { type: 'required', required: {} };
const NOT_REQUIRED = { type: 'notRequired', notRequired: {} };
const NO_LIST_LENGTH = { type: 'listLengthValidation', listLengthValidation: {} };

const oneOf = (values: string[]) => ({
  type: 'oneOf',
  oneOf: {
    type: 'oneOf',
    oneOf: {
      labelledValues: values.map((value) => ({ label: value, value: { type: 'string', string: value } })),
      otherValueAllowed: { allowed: false },
    },
  },
});

const string = (allowedValues: unknown = TEXT) => ({
  type: { type: 'string', string: {} },
  allowedValues,
  required: NOT_REQUIRED,
});

const CREATE_PARAMETERS = {
  taskId: string(),
  status: string(),
  budget: { type: { type: 'decimal', decimal: {} }, allowedValues: RANGE, required: NOT_REQUIRED },
  labels: { type: { type: 'stringList', stringList: {} }, allowedValues: TEXT, required: NO_LIST_LENGTH },
};

const task = {
  type: { type: 'objectReference', objectReference: { objectTypeId: TASK } },
  allowedValues: { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } },
  required: REQUIRED,
};

const values = (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, parameterValue(id)]));

function testIr(): OntologyIr {
  const ir = twinIr('0.6.3');

  const source = JSON.parse(
    readFileSync(new URL('../../twin/ir/value-types.json', import.meta.url), 'utf8'),
  ) as OntologyIr;

  ir.valueTypes = source.valueTypes;

  const block = source.ontology.objectTypes[TASK];

  if (!block) throw new Error('The value types IR has no Task.');

  block.entityMetadata = unchecked({ ...block.entityMetadata, arePatchesEnabled: true });

  ir.ontology.objectTypes[TASK] = block;

  const create = (apiName: string, parameters: Record<string, unknown>) =>
    actionType(apiName, unchecked(parameters), [addRule(TASK, values(Object.keys(parameters)))]);

  ir.ontology.actionTypes[CREATE_TASK] = create(CREATE_TASK, CREATE_PARAMETERS);

  ir.ontology.actionTypes[MODIFY_TASK] = actionType(
    MODIFY_TASK,
    unchecked({ task, status: string(), budget: CREATE_PARAMETERS.budget, labels: CREATE_PARAMETERS.labels }),
    [modifyRule('task', values(['status', 'budget', 'labels']))],
  );

  ir.ontology.actionTypes[CREATE_TWO_TASKS] = actionType(
    CREATE_TWO_TASKS,
    unchecked({ first: string(), second: string(), status: string() }),
    [
      addRule(TASK, {
        taskId: parameterValue('first'),
        status: { type: 'staticValue', staticValue: { type: 'string', string: 'open' } },
      }),
      addRule(TASK, { taskId: parameterValue('second'), status: parameterValue('status') }),
    ],
  );

  ir.ontology.actionTypes[CREATE_PICKED_TASK] = create(CREATE_PICKED_TASK, {
    taskId: string(),
    status: string(oneOf(['open', 'bogus'])),
  });

  const copyFrom = {
    type: 'objectParameterPropertyValue',
    objectParameterPropertyValue: { parameterId: 'source', propertyTypeId: 'labels' },
  };

  ir.ontology.actionTypes[COPY_LABELS] = actionType(COPY_LABELS, unchecked({ task, source: task }), [
    modifyRule('task', { labels: copyFrom }),
  ]);

  ir.ontology.actionTypes[SET_LABELS_TWICE] = actionType(
    SET_LABELS_TWICE,
    unchecked({ task, first: CREATE_PARAMETERS.labels, second: CREATE_PARAMETERS.labels }),
    [modifyRule('task', { labels: parameterValue('first') }), modifyRule('task', { labels: parameterValue('second') })],
  );

  return ir;
}

let service: ActionsService;
let scripted: ScriptedFunctions;

beforeAll(async () => {
  const ir = testIr();

  scripted = new ScriptedFunctions(ir);

  const scriptedFunction = {
    apiName: 'scripted',
    inputs: [{ name: 'account', type: 'object', objectType: ACCOUNT }],
    edits: [ACCOUNT, TASK],
  } as const;

  const { ir: withScripted, functions } = await withFunctions([scriptedFunction], scripted.source, ir);

  service = await startActions(withScripted, functions);
});

afterAll(() => {
  scripted?.close();

  return service?.stop();
});

beforeEach(async () => {
  scripted.reset();

  await service.clear();

  await insertObjects(service.db, ACCOUNT, [{ accountId: 'acc-1', name: 'Acme', phase: 'customer' }]);
});

const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE' };

const create = (taskId: string, parameters: Record<string, unknown>) =>
  service.apply(CREATE_TASK, { parameters: { taskId, labels: ['ok'], ...parameters }, options: EXECUTE });

const createWithFunction = (taskId: string, properties: Record<string, JsonValue>) => {
  scripted.once(() => [
    {
      type: 'addObject',
      object: { objectType: TASK, primaryKey: taskId },
      properties: new Map(Object.entries({ labels: ['ok'], ...properties })),
    },
  ]);

  return service.apply(SCRIPTED_ACTION, { parameters: { account: 'acc-1' }, options: EXECUTE });
};

const tasks = () => rowsOf(service.db, TASK, 'task_id');

const refusedValue = (property: string, valueType: string, words: string, userErrorMessage?: string) => {
  const builderErrorMessage = `The value of Property ${property} of Object Type ${TASK} breaks the value type ${valueType}: each value ${words}.`;

  return {
    status: 400,
    body: {
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'ApplyActionFailed',
      parameters: {
        originalErrorName: 'Ontos:InvalidActionPropertyFormat',
        objectType: TASK,
        property,
        userErrorMessage: userErrorMessage ?? builderErrorMessage,
        builderErrorMessage,
      },
    },
  };
};

const STATUS_WORDS = 'is one of "open", "done"';

const TAGS_WORDS =
  'is a list of 1 to 5 elements, with no element 2 times, and each element matches the regex [a-z]+ in full';

const MONEY_WORDS = 'is at least "0" and at most "1000000"';

const BASE_TYPE_REFUSAL = {
  status: 400,
  body: {
    errorCode: 'INVALID_ARGUMENT',
    errorName: 'ApplyActionFailed',
    parameters: {
      originalErrorName: 'Ontos:InvalidActionPropertyFormat',
      objectType: TASK,
      property: 'status',
      userErrorMessage: 'The Action could not apply because a Property value is invalid.',
      builderErrorMessage: 'The Function assigned a value whose type does not match the Property.',
    },
  },
};

describe('a rule-backed write that breaks a value type', () => {
  it('ontology/object-link-types/value-types#checks-on-write: a create with a status outside the enum gets 400 with the failure message of the constraint, and writes nothing', async () => {
    expect(errorAnswer(await create('t-1', { status: 'bogus' }))).toEqual(
      refusedValue('status', 'taskStatus', STATUS_WORDS, 'Use open or done.'),
    );

    expect(await tasks()).toEqual([]);
  });

  it('ontology/object-link-types/value-types#checks-on-write: a constraint with no failure message gives the plain words in both messages', async () => {
    expect(errorAnswer(await create('t-1', { budget: '1000000.01' }))).toEqual(
      refusedValue('budget', 'money', MONEY_WORDS),
    );

    expect(errorAnswer(await create('t-1', { budget: '-1' }))).toEqual(refusedValue('budget', 'money', MONEY_WORDS));

    expect(await tasks()).toEqual([]);
  });

  it('ontology/object-link-types/value-types#checks-on-write: a modify to a bad value gets the same 400, and the stored Object does not change', async () => {
    expect((await create('t-1', { status: 'open', budget: '5', labels: ['a'] })).status).toBe(200);

    const before = await tasks();

    expect(
      errorAnswer(
        await service.apply(MODIFY_TASK, {
          parameters: { task: 't-1', status: 'bogus', labels: ['a'] },
          options: EXECUTE,
        }),
      ),
    ).toEqual(refusedValue('status', 'taskStatus', STATUS_WORDS, 'Use open or done.'));

    expect(await tasks()).toEqual(before);
  });

  it('ontology/object-link-types/value-types#checks-on-write: an Action that writes 2 Objects writes none when the second breaks a value type', async () => {
    const answer = await service.apply(CREATE_TWO_TASKS, {
      parameters: { first: 't-1', second: 't-2', status: 'bogus' },
      options: EXECUTE,
    });

    expect(errorAnswer(answer)).toEqual(refusedValue('status', 'taskStatus', STATUS_WORDS, 'Use open or done.'));

    expect(await tasks()).toEqual([]);
  });

  it('ontology/object-link-types/value-types#checks-on-write: a value inside the constraints is stored', async () => {
    expect((await create('t-1', { status: 'done', budget: '12.5', labels: ['a', 'b'] })).status).toBe(200);

    expect(await tasks()).toEqual([
      expect.objectContaining({ task_id: 't-1', status: 'done', budget: '12.50', labels: ['a', 'b'] }),
    ]);
  });
});

describe('each constraint family', () => {
  it.each([
    ['an empty array', []],
    ['6 elements', ['a', 'b', 'c', 'd', 'e', 'f']],
    ['a repeated element', ['a', 'a']],
    ['an element that does not match the regex', ['a', 'B']],
  ])(
    'ontology/object-link-types/value-types#checks-on-write: an array with %s gets the failure message of tags',
    async (_, labels) => {
      expect(errorAnswer(await create('t-1', { labels }))).toEqual(
        refusedValue('labels', 'tags', TAGS_WORDS, 'Use 1 to 5 lowercase tags.'),
      );

      expect(await tasks()).toEqual([]);
    },
  );

  it('ontology/object-link-types/value-types#checks-on-write: a Decimal that equals the maximum after the padding passes, and 1 cent more fails', async () => {
    expect((await create('t-1', { budget: '1000000' })).status).toBe(200);

    expect(await tasks()).toEqual([expect.objectContaining({ task_id: 't-1', budget: '1000000.00' })]);

    expect(errorAnswer(await create('t-2', { budget: 1000000.01 }))).toEqual(
      refusedValue('budget', 'money', MONEY_WORDS),
    );
  });

  it('ontology/object-link-types/value-types#checks-on-write: a null value gets no value type check', async () => {
    expect((await create('t-1', {})).status).toBe(200);

    expect(await tasks()).toEqual([expect.objectContaining({ task_id: 't-1', status: null, budget: null })]);
  });
});

describe('a list that the request leaves unset', () => {
  it('ontology/object-link-types/value-types#checks-on-write: a rule-backed create that leaves the list unset gets no value type check and stores []', async () => {
    expect((await create('t-1', { labels: undefined })).status).toBe(200);

    expect(await tasks()).toEqual([expect.objectContaining({ task_id: 't-1', labels: [] })]);
  });

  it('ontology/object-link-types/value-types#checks-on-write: a rule-backed modify that leaves the list unset gets no value type check and stores []', async () => {
    expect((await create('t-1', { status: 'open', labels: ['a'] })).status).toBe(200);

    expect(
      (await service.apply(MODIFY_TASK, { parameters: { task: 't-1', status: 'done' }, options: EXECUTE })).status,
    ).toBe(200);

    expect(await tasks()).toEqual([expect.objectContaining({ task_id: 't-1', status: 'done', labels: [] })]);
  });

  it('ontology/object-link-types/value-types#checks-on-write: a modify that copies a list from an Object whose list is null gets 400, and writes nothing', async () => {
    expect((await create('t-1', { status: 'open', labels: ['a'] })).status).toBe(200);

    await insertObjects(service.db, TASK, [{ taskId: 't-2', status: 'open', labels: null }]);

    const before = await tasks();

    expect(
      errorAnswer(await service.apply(COPY_LABELS, { parameters: { task: 't-1', source: 't-2' }, options: EXECUTE })),
    ).toEqual(refusedValue('labels', 'tags', TAGS_WORDS, 'Use 1 to 5 lowercase tags.'));

    expect(await tasks()).toEqual(before);
  });

  it('ontology/object-link-types/value-types#checks-on-write: an Action whose first rule leaves the list unset and whose second rule sends a bad list gets 400, and the row keeps its value', async () => {
    expect((await create('t-1', { status: 'open', labels: ['a'] })).status).toBe(200);

    const before = await tasks();

    expect(
      errorAnswer(
        await service.apply(SET_LABELS_TWICE, { parameters: { task: 't-1', second: ['BAD'] }, options: EXECUTE }),
      ),
    ).toEqual(refusedValue('labels', 'tags', TAGS_WORDS, 'Use 1 to 5 lowercase tags.'));

    expect(await tasks()).toEqual(before);
  });

  it('ontology/object-link-types/value-types#checks-on-write: a create that sends [] against a minimum size of 1 gets 400, and writes nothing', async () => {
    expect(errorAnswer(await create('t-1', { labels: [] }))).toEqual(
      refusedValue('labels', 'tags', TAGS_WORDS, 'Use 1 to 5 lowercase tags.'),
    );

    expect(await tasks()).toEqual([]);
  });

  it('ontology/object-link-types/value-types#checks-on-write: a create that sends 6 elements against a maximum size of 5 gets 400, and writes nothing', async () => {
    expect(errorAnswer(await create('t-1', { labels: ['a', 'b', 'c', 'd', 'e', 'f'] }))).toEqual(
      refusedValue('labels', 'tags', TAGS_WORDS, 'Use 1 to 5 lowercase tags.'),
    );

    expect(await tasks()).toEqual([]);
  });

  it('ontology/object-link-types/value-types#checks-on-write: a Function edit that sends [] against a minimum size of 1 gets 400, and writes nothing', async () => {
    expect(errorAnswer(await createWithFunction('t-1', { labels: [] }))).toEqual(
      refusedValue('labels', 'tags', TAGS_WORDS, 'Use 1 to 5 lowercase tags.'),
    );

    expect(await tasks()).toEqual([]);
  });
});

describe('a Function edit', () => {
  it('ontology/object-link-types/value-types#checks-on-write: a Function edit that breaks a value type gets the same messages as a rule edit, and writes nothing', async () => {
    expect(errorAnswer(await createWithFunction('t-1', { status: 'bogus' }))).toEqual(
      refusedValue('status', 'taskStatus', STATUS_WORDS, 'Use open or done.'),
    );

    expect(errorAnswer(await createWithFunction('t-1', { budget: '2000000' }))).toEqual(
      refusedValue('budget', 'money', MONEY_WORDS),
    );

    expect(errorAnswer(await createWithFunction('t-1', { labels: ['a', 'a'] }))).toEqual(
      refusedValue('labels', 'tags', TAGS_WORDS, 'Use 1 to 5 lowercase tags.'),
    );

    expect(await tasks()).toEqual([]);
  });

  it('ontology/object-link-types/value-types#checks-on-write: a Function edit that breaks a base type rule keeps the Function error text', async () => {
    expect(errorAnswer(await createWithFunction('t-1', { status: 5 }))).toEqual(BASE_TYPE_REFUSAL);

    expect(await tasks()).toEqual([]);
  });

  it('ontology/object-link-types/value-types#checks-on-write: a Function edit inside the constraints is stored', async () => {
    expect((await createWithFunction('t-1', { status: 'open', budget: 7.5 })).status).toBe(200);

    expect(await tasks()).toEqual([expect.objectContaining({ task_id: 't-1', status: 'open', budget: '7.50' })]);
  });
});

describe('the allowed values of a parameter', () => {
  it('ontology/object-link-types/value-types#checks-on-write: a parameter keeps its own allowed values, and the value type adds none', async () => {
    const outside = await service.apply(CREATE_PICKED_TASK, {
      parameters: { taskId: 't-1', status: 'done' },
      options: EXECUTE,
    });

    expect(outside.status).toBe(200);
    expect(outside.body).toMatchObject({ validation: { result: 'INVALID' } });

    expect(await tasks()).toEqual([]);
  });

  it('ontology/object-link-types/value-types#checks-on-write: a value that the parameter allows and the value type refuses fails at the write check', async () => {
    const answer = await service.apply(CREATE_PICKED_TASK, {
      parameters: { taskId: 't-1', status: 'bogus' },
      options: EXECUTE,
    });

    expect(errorAnswer(answer)).toEqual(refusedValue('status', 'taskStatus', STATUS_WORDS, 'Use open or done.'));

    expect(await tasks()).toEqual([]);
  });

  it('ontology/object-link-types/value-types#checks-on-write: a rule-backed Action with no allowed values that writes a bad value fails at the write check', async () => {
    expect(errorAnswer(await create('t-1', { status: 'bogus' })).body).toMatchObject({
      errorName: 'ApplyActionFailed',
    });

    expect(await tasks()).toEqual([]);
  });
});
