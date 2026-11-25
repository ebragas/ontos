import { each, settle, type Fallible, type Result } from '../../errors/index.ts';
import type {
  ComparisonOperator,
  Condition,
  ConditionValue,
  Criterion,
  ParameterType,
  PersonFact,
  PropertyType,
} from '../compiled/index.ts';
import { CompileError } from '../compiled/stored.ts';
import { array, isRecord, record, string, tag, type JsonRecord } from '../model/shape.ts';
import { exactDecimal, staticValue } from '../parameters/allowed.ts';
import { own } from '../parameters/scalars.ts';
import { isList } from '../parameters/types.ts';
import { personFact } from '../policies/conditions.ts';
import { checkParameter, objectParameterProperty, type ActionTypeContext, type Parameters } from './context.ts';

export function* criteria(
  validation: JsonRecord,
  path: string,
  owner: string,
  parameters: Parameters,
  context: ActionTypeContext,
): Fallible<Criterion[], CompileError> {
  const rules = Object.entries(yield* record(validation['rules'], `${path}.rules`)).sort(
    ([a], [b]) => Number(a) - Number(b),
  );

  if (rules.length === 0) return [{ condition: { kind: 'true' }, failureMessage: '' }];

  return yield* each(rules, function* ([index, value]): Fallible<
    { condition: Condition; failureMessage: string },
    CompileError
  > {
    const rulePath = `${path}.rules.${index}`;
    const rule = yield* record(value, rulePath);

    return {
      condition: yield* condition(rule['condition'], `${rulePath}.condition`, owner, parameters, context),
      failureMessage: yield* string(
        (yield* record(rule['displayMetadata'], `${rulePath}.displayMetadata`))['failureMessage'],
        `${rulePath}.displayMetadata.failureMessage`,
      ),
    };
  });
}

const OPERATORS = new Set<string>([
  'EQUALS',
  'NOT_EQUALS',
  'LESS_THAN',
  'LESS_THAN_EQUALS',
  'GREATER_THAN',
  'GREATER_THAN_EQUALS',
  'INTERSECTS',
]);

const OUTSIDE_CONDITIONS: Readonly<Record<string, string>> = {
  markings: 'a condition on markings',
  executionContext: 'a condition on the execution context',
};

function* condition(
  value: unknown,
  path: string,
  owner: string,
  parameters: Parameters,
  context: ActionTypeContext,
): Fallible<Condition, CompileError> {
  const result = settleCondition(value, path, owner, parameters, context);

  if (!result.ok) return yield result.error;

  return result.value;
}

function settleCondition(
  value: unknown,
  path: string,
  owner: string,
  parameters: Parameters,
  context: ActionTypeContext,
): Result<Condition, CompileError> {
  const node = settle(conditionNode(value, path));

  if (!node.ok) return node;

  const { kind, children, body, bodyPath } = node.value;

  if (children === undefined) return settle(conditionLeaf(kind, body, bodyPath, owner, parameters, context));

  const conditions: Condition[] = [];

  for (let index = 0; index < children.length; index += 1) {
    const child = settleCondition(
      children[index],
      `${bodyPath}.${kind === 'not' ? 'condition' : `conditions.${index}`}`,
      owner,
      parameters,
      context,
    );

    if (!child.ok) return child;

    conditions.push(child.value);
  }

  const [only] = conditions;

  return {
    ok: true,
    value: kind === 'not' && only ? { kind, condition: only } : { kind: kind as 'and' | 'or', conditions },
  };
}

type ConditionNode = {
  readonly kind: string;
  readonly children: readonly unknown[] | undefined;
  readonly body: JsonRecord;
  readonly bodyPath: string;
};

function* conditionNode(value: unknown, path: string): Fallible<ConditionNode, CompileError> {
  const kind = yield* tag(value, path);
  const body = yield* record((yield* record(value, path))[kind], `${path}.${kind}`);
  const bodyPath = `${path}.${kind}`;

  if (kind === 'and' || kind === 'or')
    return { kind, children: yield* array(body['conditions'], `${bodyPath}.conditions`), body, bodyPath };

  if (kind === 'not') return { kind, children: [body['condition']], body, bodyPath };

  return { kind, children: undefined, body, bodyPath };
}

function* conditionLeaf(
  kind: string,
  body: JsonRecord,
  bodyPath: string,
  owner: string,
  parameters: Parameters,
  context: ActionTypeContext,
): Fallible<Condition, CompileError> {
  switch (kind) {
    case 'true':
      return { kind: 'true' };
    case 'comparison': {
      const operator = yield* string(body['operator'], `${bodyPath}.operator`);

      if (!OPERATORS.has(operator)) {
        return yield new CompileError(
          `${owner} has a condition with the ${operator} operator, which V1 does not have. The operators are ${[...OPERATORS].join(', ')}.`,
        );
      }

      const left = yield* conditionValue(body['left'], `${bodyPath}.left`, owner, parameters, context);
      const right = yield* conditionValue(body['right'], `${bodyPath}.right`, owner, parameters, context);

      if (left.kind === 'person' || right.kind === 'person')
        yield* checkPersonComparison(operator, left, right, owner, parameters, context);

      const exact =
        baseKind(left, parameters, context) === 'decimal' || baseKind(right, parameters, context) === 'decimal';

      return {
        kind: 'comparison',
        operator: operator as ComparisonOperator,
        left: exact ? yield* exactStatic(left, owner) : left,
        right: exact ? yield* exactStatic(right, owner) : right,
      };
    }
    case 'regex': {
      const regexValue = yield* conditionValue(body['value'], `${bodyPath}.value`, owner, parameters, context);

      if (regexValue.kind === 'person')
        return yield new CompileError(`${owner} has a regex condition on a person value. ${PERSON_COMPARISON}`);

      return { kind: 'regex', value: regexValue, regex: yield* string(body['regex'], `${bodyPath}.regex`) };
    }
  }

  const feature = own(OUTSIDE_CONDITIONS, kind);

  if (feature) return yield new CompileError(`${owner} has ${feature} (${kind}), which V1 does not have.`);

  return yield new CompileError(`${owner} has the condition ${kind}, which V1 does not have.`);
}

function* conditionValue(
  value: unknown,
  path: string,
  owner: string,
  parameters: Parameters,
  context: ActionTypeContext,
): Fallible<ConditionValue, CompileError> {
  const kind = yield* tag(value, path);
  const body = (yield* record(value, path))[kind];

  switch (kind) {
    case 'parameterId':
      return { kind: 'parameter', parameter: yield* checkParameter(body, `${path}.parameterId`, owner, parameters) };
    case 'staticValue':
      return { kind: 'static', value: yield* staticValue(body, `${path}.staticValue`, owner) };
    case 'objectParameterPropertyValue':
      return {
        kind: 'objectProperty',
        ...(yield* objectParameterProperty(body, `${path}.${kind}`, owner, parameters, context)),
      };
    case 'parameterLength': {
      const length = yield* record(body, `${path}.${kind}`);

      if ((yield* tag(length, `${path}.${kind}`)) !== 'parameterId')
        return yield new CompileError(`The IR field ${path}.${kind} is not a parameterId.`);

      const parameter = yield* checkParameter(length['parameterId'], `${path}.${kind}.parameterId`, owner, parameters);
      const type = parameters.get(parameter)?.type;

      if (!type || !isList(type))
        return yield new CompileError(`${owner} uses the length of ${parameter}, which is not a list parameter.`);

      return { kind: 'listLength', parameter };
    }
    case 'userProperty':
      return { kind: 'person', fact: yield* userProperty(body, owner) };
    case 'interfaceParameterPropertyValue':
      return yield new CompileError(
        `${owner} has a condition on an Interface parameter Property value, which V1 does not have.`,
      );
  }

  return yield new CompileError(`${owner} has the condition value ${kind}, which V1 does not have.`);
}

const PERSON_OPERATORS = new Set<string>(['EQUALS', 'NOT_EQUALS', 'INTERSECTS']);

const PERSON_COMPARISON =
  'A person value is in a comparison with EQUALS, NOT_EQUALS, or INTERSECTS, and the other value is a String or a list of Strings.';

function* userProperty(body: unknown, owner: string): Fallible<PersonFact, CompileError> {
  const refuse = function* (feature: string): Fallible<never, CompileError> {
    return yield new CompileError(`${owner} has a Submission criterion that ${feature}.`);
  };

  if (!isRecord(body)) return yield* refuse('has a person value that is not an object');

  const unknownKey = Object.keys(body).find((key) => key !== 'userId' && key !== 'propertyValue');

  if (unknownKey !== undefined) return yield* refuse(`has a person value with the unknown key ${unknownKey}`);

  const user = body['userId'];

  const isCurrentUser =
    isRecord(user) &&
    Object.keys(user).length === 2 &&
    user['type'] === 'currentUser' &&
    isRecord(user['currentUser']) &&
    Object.keys(user['currentUser']).length === 0;

  if (!isCurrentUser) return yield* refuse('reads a person other than the current user');

  return yield* personFact(body['propertyValue'], refuse);
}

function* checkPersonComparison(
  operator: string,
  left: ConditionValue,
  right: ConditionValue,
  owner: string,
  parameters: Parameters,
  context: ActionTypeContext,
): Fallible<void, CompileError> {
  if (!PERSON_OPERATORS.has(operator))
    return yield new CompileError(
      `${owner} has a comparison of a person value with the ${operator} operator. ${PERSON_COMPARISON}`,
    );

  if (left.kind === 'person' && right.kind === 'person')
    return yield new CompileError(`${owner} has a comparison of 2 person values. ${PERSON_COMPARISON}`);

  const [person, other] = left.kind === 'person' ? [left, right] : [right, left];

  if (person.kind === 'person' && person.fact.kind === 'permissions' && operator !== 'INTERSECTS') {
    return yield new CompileError(
      `${owner} has a comparison of user.permissions with the ${operator} operator. A comparison of user.permissions uses INTERSECTS (holds 1 of these).`,
    );
  }

  if (!isStrings(other, parameters, context))
    return yield new CompileError(
      `${owner} has a comparison of a person value and a ${other.kind} value that is not a String. ${PERSON_COMPARISON}`,
    );
}

function isStrings(value: ConditionValue, parameters: Parameters, context: ActionTypeContext): boolean {
  if (value.kind !== 'static') return baseKind(value, parameters, context) === 'string';

  return (
    typeof value.value === 'string' ||
    (Array.isArray(value.value) && value.value.every((each) => typeof each === 'string'))
  );
}

function baseKind(
  value: ConditionValue,
  parameters: Parameters,
  context: ActionTypeContext,
): ParameterType['kind'] | PropertyType['kind'] | undefined {
  const type =
    value.kind === 'parameter' || value.kind === 'objectProperty' ? parameters.get(value.parameter)?.type : undefined;

  if (value.kind === 'parameter') return type?.kind === 'list' ? type.element.kind : type?.kind;

  if (value.kind !== 'objectProperty' || type?.kind !== 'object') return undefined;

  const property = context.objectTypes.get(type.objectType)?.properties.get(value.property);

  return property?.type.kind === 'array' ? property.type.element.kind : property?.type.kind;
}

function* exactStatic(value: ConditionValue, owner: string): Fallible<ConditionValue, CompileError> {
  if (value.kind !== 'static' || value.value === null) return value;

  return {
    kind: 'static',
    value: Array.isArray(value.value)
      ? yield* each(value.value, function* (each): Fallible<string, CompileError> {
          return yield* exactDecimal(each, owner);
        })
      : yield* exactDecimal(value.value, owner),
  };
}
