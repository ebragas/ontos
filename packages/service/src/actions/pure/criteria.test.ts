import { describe, expect, it } from 'vitest';
import { evaluateCriteria } from './criteria.ts';
import type { LoadedObject } from '../objects.ts';
import { personValue } from '../../db/index.ts';
import { openReader, type Db } from '../../db/promise.test-utils.ts';
import {
  type CompiledActionType,
  type CompiledOntology,
  type Condition,
  type ConditionValue,
  type JsonValue,
  type PersonFact,
} from '../../ontology/index.ts';
import { compileOrThrow, NS, stored, twinFunctions, twinIr } from '../../ontology/stored.test-utils.ts';
import { SCHEMAS } from '../../service.test-utils.ts';
import { UserId } from '../../auth/caller.ts';

const CREATE_ENGAGEMENT = `${NS}create-engagement`;
const TRUE_CRITERION = { condition: { kind: 'true' }, failureMessage: '' };

const NO_PERSON = (): never => {
  throw new Error('No criterion of this test reads the person.');
};

const NO_INPUTS = { parameters: new Map(), objects: new Map(), person: NO_PERSON };

function compiled(edit: (rules: Record<string, unknown>) => Record<string, unknown> = (rules) => rules) {
  const ir = twinIr('0.6.3');
  const block = ir.ontology.actionTypes[CREATE_ENGAGEMENT];

  if (!block) throw new Error('The twin 0.6.3 IR has no create-engagement.');

  const validation = block.actionType.actionTypeLogic.validation.actionTypeLevelValidation;

  validation.rules = edit(validation.rules) as typeof validation.rules;

  const ontology: CompiledOntology = compileOrThrow(stored(ir, { functions: twinFunctions('0.6.3') }));
  const actionType = ontology.actionTypes.get(CREATE_ENGAGEMENT);

  if (!actionType) throw new Error('compileOntology gave no create-engagement.');

  return { actionType, ontology };
}

describe('the criterion of an Action Type with no criteria', () => {
  it('ontology/action-types/submission-criteria#contract: the criterion that @osdk/maker writes for no criteria is 1 true criterion, which passes', () => {
    const { actionType, ontology } = compiled();

    expect(actionType.criteria).toEqual([TRUE_CRITERION]);
    expect(evaluateCriteria(actionType, ontology, NO_INPUTS)).toEqual({ valid: true, results: [] });
  });

  it('ontology/action-types/submission-criteria#contract: an IR with no criteria at all also gives 1 true criterion, which passes', () => {
    const { actionType, ontology } = compiled(() => ({}));

    expect(actionType.criteria).toEqual([TRUE_CRITERION]);
    expect(evaluateCriteria(actionType, ontology, NO_INPUTS)).toEqual({ valid: true, results: [] });
  });
});

const PERSON_RULES = 'ontology/action-types/submission-criteria#person-values';
const REGION: ConditionValue = { kind: 'person', fact: { kind: 'attribute', name: 'region' } };
const PERMISSIONS: ConditionValue = { kind: 'person', fact: { kind: 'permissions' } };
const TEAM: ConditionValue = { kind: 'person', fact: { kind: 'attribute', name: 'team' } };

const ENGAGEMENT_OBJECT: LoadedObject = {
  objectType: 'Engagement',
  primaryKey: 'e-1',
  version: '1',
  properties: new Map<string, JsonValue>([
    ['owner', 'a'],
    ['teams', ['b', 'a']],
  ]),
};

const FROM_PARAMETER: ConditionValue = { kind: 'parameter', parameter: 'status' };
const FROM_PROPERTY: ConditionValue = { kind: 'objectProperty', parameter: 'engagement', property: 'owner' };
const FROM_ARRAY_PROPERTY: ConditionValue = { kind: 'objectProperty', parameter: 'engagement', property: 'teams' };
const FROM_NULL_PROPERTY: ConditionValue = { kind: 'objectProperty', parameter: 'engagement', property: 'missing' };
const TRUE: Condition = { kind: 'true' };
const FALSE: Condition = { kind: 'not', condition: TRUE };
const not = (condition: Condition): Condition => ({ kind: 'not', condition });
const and = (...conditions: Condition[]): Condition => ({ kind: 'and', conditions });
const or = (...conditions: Condition[]): Condition => ({ kind: 'or', conditions });

const compare = (
  operator: 'EQUALS' | 'NOT_EQUALS' | 'INTERSECTS',
  left: ConditionValue,
  right: ConditionValue,
): Condition => ({ kind: 'comparison', operator, left, right });

const statically = (value: JsonValue): ConditionValue => ({ kind: 'static', value });

const DEFAULT_COMPILED = compiled();

function check(condition: Condition, values: readonly string[], status: JsonValue = 'a') {
  const { actionType, ontology } = DEFAULT_COMPILED;

  const withCriterion: CompiledActionType = {
    ...actionType,
    criteria: [{ condition, failureMessage: 'Needs the person.' }],
  };

  const person = (fact: PersonFact) => (fact.kind === 'attribute' ? values : ['u-1']);

  return evaluateCriteria(withCriterion, ontology, {
    parameters: new Map([['status', status]]),
    objects: new Map([['engagement', ENGAGEMENT_OBJECT]]),
    person,
  });
}

const PASSES = { valid: true, results: [] };
const FAILS = { valid: false, results: [{ configuredFailureMessage: 'Needs the person.', result: 'INVALID' }] };

describe('a comparison of a person value', () => {
  it.each([
    ['EQUALS', [], FAILS, FAILS],
    ['EQUALS', ['a'], PASSES, FAILS],
    ['EQUALS', ['b'], FAILS, PASSES],
    ['EQUALS', ['a', 'b'], FAILS, PASSES],
    ['NOT_EQUALS', [], FAILS, FAILS],
    ['NOT_EQUALS', ['a'], FAILS, PASSES],
    ['NOT_EQUALS', ['b'], PASSES, FAILS],
    ['NOT_EQUALS', ['a', 'b'], PASSES, FAILS],
    ['INTERSECTS', [], FAILS, FAILS],
    ['INTERSECTS', ['a'], PASSES, FAILS],
    ['INTERSECTS', ['b'], FAILS, PASSES],
    ['INTERSECTS', ['b', 'a'], PASSES, FAILS],
  ] as const)(
    `${PERSON_RULES}/680a1de0: the Person attribute region %s 'a' for the person value %j, and its not`,
    (operator, values, plain, negated) => {
      const condition = compare(operator, REGION, statically('a'));

      expect(check(condition, values)).toEqual(plain);
      expect(check(not(condition), values)).toEqual(negated);
    },
  );

  it(`not of an unknown stays unknown, so not(not(...)) of an empty person value also fails`, () => {
    for (const operator of ['EQUALS', 'NOT_EQUALS', 'INTERSECTS'] as const) {
      expect(check(not(not(compare(operator, TEAM, statically('a')))), [])).toEqual(FAILS);
    }
  });

  it(`or with a passing branch and an unknown branch passes`, () => {
    expect(check(or(compare('INTERSECTS', TEAM, FROM_PARAMETER), TRUE), [])).toEqual(PASSES);
    expect(check(or(TRUE, not(compare('INTERSECTS', TEAM, FROM_PARAMETER))), [])).toEqual(PASSES);
  });

  it(`or with a failing branch and an unknown branch is unknown, and its not also fails`, () => {
    expect(check(or(FALSE, compare('EQUALS', REGION, statically('a'))), [])).toEqual(FAILS);
    expect(check(not(or(FALSE, compare('EQUALS', REGION, statically('a')))), [])).toEqual(FAILS);
  });

  it(`and with a failing branch fails, so its not passes, also with an unknown branch`, () => {
    expect(check(and(compare('EQUALS', REGION, statically('a')), FALSE), [])).toEqual(FAILS);
    expect(check(not(and(compare('EQUALS', REGION, statically('a')), FALSE)), [])).toEqual(PASSES);
    expect(check(not(and(TRUE, compare('EQUALS', REGION, statically('a')))), [])).toEqual(FAILS);
  });

  it(`a criterion that is unknown at the top fails with its own failure message, and the other criteria give their results`, () => {
    const { actionType, ontology } = compiled();

    const criteria = [
      { condition: TRUE, failureMessage: 'Never shown.' },
      {
        condition: not(compare('INTERSECTS', PERMISSIONS, statically(['admin']))),
        failureMessage: 'Admins cannot submit.',
      },
      { condition: FALSE, failureMessage: 'Always fails.' },
    ];

    const check = evaluateCriteria({ ...actionType, criteria }, ontology, {
      parameters: new Map(),
      objects: new Map(),
      person: () => [],
    });

    expect(check).toEqual({
      valid: false,
      results: [
        { configuredFailureMessage: 'Admins cannot submit.', result: 'INVALID' },
        { configuredFailureMessage: 'Always fails.', result: 'INVALID' },
      ],
    });
  });

  it(`user.permissions INTERSECTS 'admin' OR jobsiteId INTERSECTS user.jobsiteIds passes for a caller with the permission admin and no jobsite`, () => {
    const { actionType, ontology } = compiled();

    const condition = or(
      compare('INTERSECTS', PERMISSIONS, statically(['admin'])),
      compare('INTERSECTS', FROM_PARAMETER, TEAM),
    );

    const person = (fact: PersonFact) => (fact.kind === 'permissions' ? ['admin'] : []);

    const check = evaluateCriteria({ ...actionType, criteria: [{ condition, failureMessage: 'No.' }] }, ontology, {
      parameters: new Map([['status', 'j-1']]),
      objects: new Map(),
      person,
    });

    expect(check).toEqual(PASSES);
  });

  it(`${PERSON_RULES}/680a1de0: EQUALS compares the case of each String, and a String array is never equal to 1 String`, () => {
    expect(check(compare('EQUALS', REGION, statically('A')), ['a'])).toEqual(FAILS);
    expect(check(compare('EQUALS', REGION, statically(['a'])), ['a'])).toEqual(FAILS);
    expect(check(compare('EQUALS', REGION, FROM_ARRAY_PROPERTY), ['a'])).toEqual(FAILS);
    expect(check(compare('INTERSECTS', REGION, FROM_ARRAY_PROPERTY), ['a'])).toEqual(PASSES);
  });

  it(`${PERSON_RULES}/680a1de0: a parameter or a Property with no value is not equal to a person value that is not empty, and shares no String with it`, () => {
    expect(check(compare('EQUALS', REGION, FROM_NULL_PROPERTY), ['a'])).toEqual(FAILS);
    expect(check(compare('NOT_EQUALS', REGION, FROM_NULL_PROPERTY), ['a'])).toEqual(PASSES);
    expect(check(compare('INTERSECTS', REGION, FROM_NULL_PROPERTY), ['a'])).toEqual(FAILS);
    expect(check(compare('EQUALS', FROM_PARAMETER, REGION), ['a'], null)).toEqual(FAILS);
    expect(check(compare('INTERSECTS', FROM_PARAMETER, REGION), ['a'], null)).toEqual(FAILS);
  });

  it.each([
    ['a null Property', FROM_NULL_PROPERTY, 'a'],
    ['an omitted optional parameter', { kind: 'parameter', parameter: 'note' } as ConditionValue, 'a'],
    ['an empty static String array', statically([]), 'a'],
  ] as const)(
    `${PERSON_RULES}/680a1de0: against %s, EQUALS fails, NOT_EQUALS passes, and INTERSECTS fails, for the person value ['a']`,
    (_name, other, status) => {
      expect(check(compare('EQUALS', REGION, other), ['a'], status)).toEqual(FAILS);
      expect(check(compare('NOT_EQUALS', REGION, other), ['a'], status)).toEqual(PASSES);
      expect(check(compare('INTERSECTS', REGION, other), ['a'], status)).toEqual(FAILS);
      expect(check(compare('NOT_EQUALS', REGION, other), [], status)).toEqual(FAILS);
    },
  );

  it(`${PERSON_RULES}/680a1de0: a prefix or the empty String is not equal to a person String, and shares no String with it, on each side`, () => {
    expect(check(compare('INTERSECTS', REGION, statically('a')), ['ab'])).toEqual(FAILS);
    expect(check(compare('INTERSECTS', REGION, statically('')), ['ab'])).toEqual(FAILS);
    expect(check(compare('INTERSECTS', REGION, statically(['a', ''])), ['ab'])).toEqual(FAILS);
    expect(check(compare('INTERSECTS', REGION, statically('ab')), ['a'])).toEqual(FAILS);
    expect(check(compare('INTERSECTS', statically('a'), REGION), ['ab'])).toEqual(FAILS);
    expect(check(compare('EQUALS', REGION, statically('a')), ['ab'])).toEqual(FAILS);
    expect(check(compare('EQUALS', REGION, statically('ab')), ['a'])).toEqual(FAILS);
    expect(check(compare('EQUALS', statically(''), REGION), ['ab'])).toEqual(FAILS);
    expect(check(compare('NOT_EQUALS', REGION, statically('a')), ['ab'])).toEqual(PASSES);
  });

  it(`${PERSON_RULES}/680a1de0: a person value that holds U+0000 compares as its String`, () => {
    expect(check(compare('EQUALS', REGION, FROM_PARAMETER), ['a\u0000'], 'a\u0000')).toEqual(PASSES);
    expect(check(compare('EQUALS', REGION, FROM_PARAMETER), ['a\u0000'], 'a')).toEqual(FAILS);
  });

  const OTHERS: readonly (readonly [string, ConditionValue, JsonValue])[] = [
    ['static a', statically('a'), 'a'],
    ['static b', statically('b'), 'b'],
    ['static [a, b]', statically(['a', 'b']), ['a', 'b']],
    ['static []', statically([]), []],
    ['parameter a', FROM_PARAMETER, 'a'],
    ['Property a', FROM_PROPERTY, 'a'],
    ['Property [b, a]', FROM_ARRAY_PROPERTY, ['b', 'a']],
    ['null Property', FROM_NULL_PROPERTY, null],
  ];

  const PEOPLE: readonly (readonly string[])[] = [[], ['a'], ['b'], ['a', 'b']];
  const OPERATORS = ['EQUALS', 'NOT_EQUALS', 'INTERSECTS'] as const;

  type Oracle = (leaf: number) => number;

  const WRAPPERS: readonly (readonly [string, (leaf: Condition) => Condition, Oracle])[] = [
    ['bare', (c) => c, (x) => x],
    ['not', (c) => not(c), (x) => 1 - x],
    ['and true', (c) => and(c, TRUE), (x) => Math.min(x, 1)],
    ['and false', (c) => and(FALSE, c), (x) => Math.min(x, 0)],
    ['or true', (c) => or(c, TRUE), (x) => Math.max(x, 1)],
    ['or false', (c) => or(FALSE, c), (x) => Math.max(x, 0)],
    ['not or false', (c) => not(or(c, FALSE)), (x) => 1 - Math.max(x, 0)],
    ['and of or false', (c) => and(TRUE, or(FALSE, c)), (x) => Math.min(1, Math.max(0, x))],
    ['not and of not', (c) => not(and(TRUE, not(c))), (x) => 1 - Math.min(1, 1 - x)],
    ['or of not and', (c) => or(FALSE, not(and(c, c))), (x) => Math.max(0, 1 - Math.min(x, x))],
  ];

  const leaf = (operator: (typeof OPERATORS)[number], values: readonly string[], other: JsonValue): number => {
    if (values.length === 0) return 0.5;

    const others = Array.isArray(other) ? other : other === null ? [] : [other];

    if (operator === 'INTERSECTS') return values.some((value) => others.includes(value)) ? 1 : 0;

    const equal = values.length === 1 && typeof other === 'string' && other === values[0];

    return (operator === 'EQUALS') === equal ? 1 : 0;
  };

  const table = OPERATORS.flatMap((operator) =>
    PEOPLE.flatMap((values) =>
      OTHERS.flatMap(([otherName, other, otherValue]) =>
        WRAPPERS.map(
          ([wrapperName, wrap, oracle]) =>
            [operator, values, otherName, other, otherValue, wrapperName, wrap, oracle] as const,
        ),
      ),
    ),
  );

  it(`${PERSON_RULES}/680a1de0: each of the ${OPERATORS.length * PEOPLE.length * OTHERS.length * WRAPPERS.length} cases of the table agrees with an independent 3-valued oracle, with the person value on each side`, () => {
    for (const [operator, values, otherName, other, otherValue, wrapperName, wrap, oracle] of table) {
      const expected = oracle(leaf(operator, values, otherValue)) === 1 ? PASSES : FAILS;
      const name = `${wrapperName}(${operator} ${JSON.stringify(values)} ${otherName})`;

      expect(check(wrap(compare(operator, TEAM, other)), values), name).toEqual(expected);
      expect(check(wrap(compare(operator, other, TEAM)), values), `${name}, swapped`).toEqual(expected);
    }
  });
});

describe('user.permissions in a submission criterion, read from the person who applies the Action', () => {
  const read = (): never => {
    throw new Error('The reader read the database.');
  };

  const NO_DB: Db = {
    query: () => Promise.reject(new Error('The reader read the database.')),
    stream: read,
    transaction: read,
    snapshot: read,
  };

  const checkFor = async (condition: Condition, permissions: readonly string[]) => {
    const { actionType, ontology } = DEFAULT_COMPILED;

    const { reader } = await openReader(NO_DB, SCHEMAS, [], { user: UserId.parse('u-1'), permissions });

    const withCriterion: CompiledActionType = {
      ...actionType,
      criteria: [{ condition, failureMessage: 'Needs the person.' }],
    };

    return evaluateCriteria(withCriterion, ontology, {
      parameters: new Map([['status', 'x']]),
      objects: new Map([['engagement', ENGAGEMENT_OBJECT]]),
      person: (fact) => personValue(reader, fact),
    });
  };

  it.each([
    [[], FAILS, FAILS],
    [['x'], PASSES, FAILS],
    [['z'], FAILS, PASSES],
    [['x', 'z'], PASSES, FAILS],
    [['y', 'z'], PASSES, FAILS],
  ] as const)(
    `${PERSON_RULES}/2d28a1a0 ${PERSON_RULES}/bfcfbcd8: user.permissions INTERSECTS x and y for the permissions %j, and its not`,
    async (permissions, plain, negated) => {
      const condition = compare('INTERSECTS', PERMISSIONS, statically(['x', 'y']));

      expect(await checkFor(condition, permissions)).toEqual(plain);

      expect(await checkFor(not(condition), permissions)).toEqual(negated);
    },
  );

  it.each([
    ['a String parameter', FROM_PARAMETER, [['x', 'z'], ['z']]],
    ['a String Property of an Object parameter', FROM_PROPERTY, [['a'], ['x']]],
    [
      'a String array Property of an Object parameter',
      FROM_ARRAY_PROPERTY,
      [
        ['z', 'b'],
        ['x', 'z'],
      ],
    ],
  ] as const)(
    `${PERSON_RULES}/2d28a1a0: user.permissions INTERSECTS %s, on each side`,
    async (_other, other, [holds, lacks]) => {
      expect(await checkFor(compare('INTERSECTS', PERMISSIONS, other), holds)).toEqual(PASSES);

      expect(await checkFor(compare('INTERSECTS', other, PERMISSIONS), holds)).toEqual(PASSES);

      expect(await checkFor(compare('INTERSECTS', PERMISSIONS, other), lacks)).toEqual(FAILS);

      expect(await checkFor(compare('INTERSECTS', other, PERMISSIONS), lacks)).toEqual(FAILS);
    },
  );

  it(`${PERSON_RULES}/2d28a1a0: user.permissions is the set of permissions of the caller`, async () => {
    expect(await checkFor(compare('INTERSECTS', PERMISSIONS, statically(['admin'])), [])).toEqual(FAILS);

    expect(await checkFor(compare('INTERSECTS', PERMISSIONS, statically(['admin'])), ['admin'])).toEqual(PASSES);
  });

  it(`${PERSON_RULES}/9310bc5c: for a caller with no permission, user.permissions is unknown, and not, and, and or keep the unknown`, async () => {
    const holds = compare('INTERSECTS', PERMISSIONS, statically(['x']));

    expect(await checkFor(holds, [])).toEqual(FAILS);

    expect(await checkFor(not(holds), [])).toEqual(FAILS);

    expect(await checkFor(not(not(holds)), [])).toEqual(FAILS);

    expect(await checkFor(and(TRUE, holds), [])).toEqual(FAILS);

    expect(await checkFor(not(and(TRUE, holds)), [])).toEqual(FAILS);

    expect(await checkFor(not(and(FALSE, holds)), [])).toEqual(PASSES);

    expect(await checkFor(or(FALSE, holds), [])).toEqual(FAILS);

    expect(await checkFor(not(or(FALSE, holds)), [])).toEqual(FAILS);

    expect(await checkFor(or(TRUE, holds), [])).toEqual(PASSES);
  });
});
