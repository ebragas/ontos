import { settle, type Fallible, type Result } from '../../errors/index.ts';
import type { CompiledObjectType } from '../compiled/objects.ts';
import type { PersonFact, Policy, PolicyObjectSide, PolicyOperator } from '../compiled/policies.ts';
import { type CompileError } from '../compiled/stored.ts';
import { storedProperty } from '../derived/ir.ts';
import { isRecord, type JsonRecord } from '../model/shape.ts';

export type Refuse = (feature: string) => Fallible<never, CompileError>;

export function* onlyKeys(
  value: JsonRecord,
  allowed: readonly string[],
  what: string,
  refuse: Refuse,
): Fallible<void, CompileError> {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));

  if (unknown !== undefined) yield* refuse(`has ${what} with the unknown key ${unknown}`);
}

function* conditionsOf(condition: JsonRecord, kind: 'and' | 'or', refuse: Refuse): Fallible<unknown[], CompileError> {
  const body = condition[kind];

  if (!isRecord(body) || !Array.isArray(body['conditions']))
    return yield* refuse(`has an ${kind} with no list of conditions`);

  yield* onlyKeys(body, ['conditions'], `an ${kind}`, refuse);

  if (kind === 'and' && body['conditions'].length === 0) return yield* refuse('has an and with no condition');

  return body['conditions'];
}

export function* compileCondition(
  condition: unknown,
  objectType: CompiledObjectType<unknown>,
  refuse: Refuse,
): Fallible<Policy, CompileError> {
  const result = settleCondition(condition, objectType, refuse);

  if (!result.ok) return yield result.error;

  return result.value;
}

function settleCondition(
  condition: unknown,
  objectType: CompiledObjectType<unknown>,
  refuse: Refuse,
): Result<Policy, CompileError> {
  if (!isRecord(condition) || (condition['type'] !== 'and' && condition['type'] !== 'or'))
    return settle(compileLeaf(condition, objectType, refuse));

  const kind = condition['type'];
  const list = settle(openConditions(condition, kind, refuse));

  if (!list.ok) return list;

  const conditions: Policy[] = [];

  for (const item of list.value) {
    const each = settleCondition(item, objectType, refuse);

    if (!each.ok) return each;

    conditions.push(each.value);
  }

  return { ok: true, value: { kind, conditions } };
}

function* openConditions(condition: JsonRecord, kind: 'and' | 'or', refuse: Refuse): Fallible<unknown[], CompileError> {
  const conditions = yield* conditionsOf(condition, kind, refuse);

  yield* onlyKeys(condition, ['type', kind], 'a condition', refuse);

  return conditions;
}

function* compileLeaf(
  condition: unknown,
  objectType: CompiledObjectType<unknown>,
  refuse: Refuse,
): Fallible<Policy, CompileError> {
  if (!isRecord(condition)) return yield* refuse('has a condition that is not an object');

  switch (condition['type']) {
    case 'comparison':
      yield* onlyKeys(condition, ['type', 'comparison'], 'a condition', refuse);

      return yield* compileComparison(condition['comparison'], objectType, refuse);
    case 'not':
      return yield* refuse('uses not. A not on a person value that is missing grants access, so V1 refuses it');
    case 'markings':
    case 'constantMarkings':
      return yield* refuse('reads markings. V1 has no markings');
    default:
      return yield* refuse(
        `uses the condition ${String(condition['type'])}. A V1 condition is a comparison, an and, or an or`,
      );
  }
}

const OPERATORS: ReadonlyMap<unknown, PolicyOperator> = new Map([
  ['EQUAL', 'equal'],
  ['INTERSECTS', 'intersects'],
  ['SUBSET_OF', 'subsetOf'],
  ['SUPERSET_OF', 'supersetOf'],
]);

const SWAPPED: Readonly<Record<PolicyOperator, PolicyOperator>> = {
  equal: 'equal',
  intersects: 'intersects',
  subsetOf: 'supersetOf',
  supersetOf: 'subsetOf',
};

type Side =
  { readonly kind: 'person'; readonly fact: PersonFact } | { readonly kind: 'object'; readonly side: PolicyObjectSide };

function* compileComparison(
  comparison: unknown,
  objectType: CompiledObjectType<unknown>,
  refuse: Refuse,
): Fallible<Policy, CompileError> {
  if (!isRecord(comparison)) return yield* refuse('has a comparison that is not an object');

  yield* onlyKeys(comparison, ['operator', 'left', 'right'], 'a comparison', refuse);

  const operator = OPERATORS.get(comparison['operator']);

  if (!operator)
    return yield* refuse(
      `uses the operator ${String(comparison['operator'])}. A V1 comparison uses EQUAL, INTERSECTS, SUBSET_OF, or SUPERSET_OF`,
    );

  const left = yield* compileSide(comparison['left'], objectType, refuse);
  const right = yield* compileSide(comparison['right'], objectType, refuse);

  if (left.kind === 'person' && right.kind === 'person')
    return yield* refuse('has a comparison with 2 person sides. A comparison has 1 person side');

  if (left.kind === 'object' && right.kind === 'object')
    return yield* refuse('has a comparison with no person side. A comparison has 1 person side');

  const compiled: Policy =
    left.kind === 'person' && right.kind === 'object'
      ? { kind: 'compare', object: right.side, operator: SWAPPED[operator], person: left.fact }
      : {
          kind: 'compare',
          object: (left as Extract<Side, { kind: 'object' }>).side,
          operator,
          person: (right as Extract<Side, { kind: 'person' }>).fact,
        };

  if (compiled.person.kind === 'permissions' && (compiled.operator === 'equal' || compiled.operator === 'supersetOf')) {
    const after =
      compiled.operator === operator
        ? ''
        : `, which is ${OPERATOR_NAMES[compiled.operator]} after the swap of the 2 sides`;

    yield* refuse(
      `compares user.permissions with the operator ${String(comparison['operator'])}${after}. A comparison of user.permissions uses intersects (holds 1 of these) or subset of (holds each of these)`,
    );
  }

  return compiled;
}

const OPERATOR_NAMES: Readonly<Record<PolicyOperator, string>> = {
  equal: 'equals',
  intersects: 'intersects',
  subsetOf: 'subset of',
  supersetOf: 'superset of',
};

function* compileSide(
  value: unknown,
  objectType: CompiledObjectType<unknown>,
  refuse: Refuse,
): Fallible<Side, CompileError> {
  if (!isRecord(value)) return yield* refuse('has a comparison side that is not an object');

  yield* onlyKeys(value, ['type', String(value['type'])], 'a comparison side', refuse);

  switch (value['type']) {
    case 'constant':
      return { kind: 'object', side: { kind: 'constant', values: yield* constantValues(value['constant'], refuse) } };
    case 'property': {
      const name = String(value['property']);
      const property = yield* storedProperty(objectType, name, 'read by a security policy');

      if (!property) return yield* refuse(`reads the Property ${name}, which the Object Type does not have`);

      const isString =
        property.type.kind === 'string' || (property.type.kind === 'array' && property.type.element.kind === 'string');

      if (!isString)
        return yield* refuse(
          `reads the Property ${name}, which is not a String or a String array. A policy compares only String and String array Properties`,
        );

      return { kind: 'object', side: { kind: 'property', property: name } };
    }
    case 'userProperty':
      return { kind: 'person', fact: yield* personFact(value['userProperty'], refuse) };
    default:
      return yield* refuse(`has the comparison side ${String(value['type'])}`);
  }
}

function* constantValues(constant: unknown, refuse: Refuse): Fallible<string[], CompileError> {
  if (isRecord(constant)) yield* onlyKeys(constant, ['type', String(constant['type'])], 'a constant', refuse);

  if (isRecord(constant) && constant['type'] === 'string' && typeof constant['string'] === 'string')
    return [constant['string']];

  if (
    isRecord(constant) &&
    constant['type'] === 'strings' &&
    Array.isArray(constant['strings']) &&
    constant['strings'].every((each) => typeof each === 'string')
  ) {
    return constant['strings'] as string[];
  }

  if (isRecord(constant) && constant['type'] === 'boolean')
    return yield* refuse('compares a Boolean constant. A policy compares only Strings');

  return yield* refuse('has a constant that is not a String or a list of Strings');
}

export function* personFact(userProperty: unknown, refuse: Refuse): Fallible<PersonFact, CompileError> {
  if (!isRecord(userProperty)) return yield* refuse('has a person value that is not an object');

  const type = userProperty['type'];

  yield* onlyKeys(userProperty, ['type', String(type)], 'a person value', refuse);

  const body = userProperty[String(type)];

  switch (type) {
    case 'userId':
    case 'groupIds':
      if (!isRecord(body)) return yield* refuse(`has a ${type} value with no body`);

      yield* onlyKeys(body, [], `a ${type} value`, refuse);

      return type === 'userId' ? { kind: 'userId' } : { kind: 'permissions' };
    case 'userAttributes': {
      if (!isRecord(body)) return yield* refuse('has a Person attribute with no attributeKey');

      yield* onlyKeys(body, ['attributeKey'], 'a Person attribute', refuse);

      const name = body['attributeKey'];

      if (typeof name !== 'string' || name === '') return yield* refuse('has a Person attribute with no attributeKey');

      return { kind: 'attribute', name };
    }
    case 'username':
      return yield* refuse(`reads the username of the person. ${PERSON_VALUES}`);
    case 'groupNames':
      return yield* refuse(`reads the group names of the person. ${PERSON_VALUES}`);
    default:
      return yield* refuse(`reads the person value ${String(type)}. ${PERSON_VALUES}`);
  }
}

const PERSON_VALUES = 'A person value is user.id, user.permissions, or a Person attribute';
