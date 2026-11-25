import type { SubmissionCriteriaEvaluation } from '@osdk/foundry.ontologies';
import type {
  CompiledActionType,
  CompiledOntology,
  Condition,
  ConditionValue,
  JsonValue,
  ParameterId,
  ParameterType,
  PersonFact,
  ScalarType,
} from '../../ontology/index.ts';
import { invariant } from '../../errors/index.ts';
import type { RuleContext } from './rules.ts';
import { compareScalar, regexOf, type Order } from '../../valueTypes/index.ts';
import { objectOf } from './shared.ts';

export interface CriteriaCheck {
  readonly valid: boolean;
  readonly results: readonly SubmissionCriteriaEvaluation[];
}

type CriteriaContext = Pick<RuleContext, 'parameters' | 'objects'> & {
  readonly person: (fact: PersonFact) => readonly string[];
};

export function evaluateCriteria(
  actionType: CompiledActionType,
  ontology: CompiledOntology,
  context: CriteriaContext,
): CriteriaCheck {
  const scope: Scope = { actionType, ontology, context };

  const results = actionType.criteria
    .filter((criterion) => passes(criterion.condition, scope) !== true)
    .map((criterion): SubmissionCriteriaEvaluation => ({
      configuredFailureMessage: criterion.failureMessage,
      result: 'INVALID',
    }));

  return { valid: results.length === 0, results };
}

export function criteriaObjectParameters(actionType: CompiledActionType): ReadonlySet<ParameterId> {
  const ids = new Set<ParameterId>();

  const visit = (condition: Condition): void => {
    switch (condition.kind) {
      case 'true':
        return;
      case 'and':
      case 'or':
        return condition.conditions.forEach(visit);
      case 'not':
        return visit(condition.condition);
      case 'regex':
        return add(condition.value);
      case 'comparison':
        add(condition.left);

        return add(condition.right);
    }
  };

  const add = (value: ConditionValue): void => {
    if (value.kind === 'objectProperty') ids.add(value.parameter);
  };

  for (const criterion of actionType.criteria) visit(criterion.condition);

  return ids;
}

interface Scope {
  readonly actionType: CompiledActionType;
  readonly ontology: CompiledOntology;
  readonly context: CriteriaContext;
}

const UNKNOWN = 'unknown';

type Truth = boolean | typeof UNKNOWN;

function passes(condition: Condition, scope: Scope): Truth {
  switch (condition.kind) {
    case 'true':
      return true;
    case 'and':
      return combine(condition.conditions, scope, false);
    case 'or':
      return combine(condition.conditions, scope, true);
    case 'not': {
      const truth = passes(condition.condition, scope);

      return truth === UNKNOWN ? UNKNOWN : !truth;
    }
    case 'regex': {
      const value = valueOf(scope, condition.value);

      return typeof value === 'string' && (regexOf(condition.regex, false)?.(value) ?? false);
    }
    case 'comparison':
      return condition.left.kind === 'person' || condition.right.kind === 'person'
        ? comparesPerson(condition, scope)
        : compares(condition, scope);
  }
}

function combine(conditions: readonly Condition[], scope: Scope, decides: boolean): Truth {
  let truth: Truth = !decides;

  for (const each of conditions) {
    const value = passes(each, scope);

    if (value === decides) return decides;

    if (value === UNKNOWN) truth = UNKNOWN;
  }

  return truth;
}

function comparesPerson({ operator, left, right }: Extract<Condition, { kind: 'comparison' }>, scope: Scope): Truth {
  const [person, other] = left.kind === 'person' ? [left, right] : [right, left];

  invariant(person.kind === 'person', 'A person comparison has no person side.');

  const values = scope.context.person(person.fact);

  if (values.length === 0) return UNKNOWN;

  const value = valueOf(scope, other);
  const equals = values.length === 1 && value === values[0];

  switch (operator) {
    case 'EQUALS':
      return equals;
    case 'NOT_EQUALS':
      return !equals;
    case 'INTERSECTS':
      return listOf(value).some((element) => typeof element === 'string' && values.includes(element));
    default:
      invariant(false, `Compile refuses a person value with the ${operator} operator.`);
  }
}

type Kind = ScalarType['kind'] | ReadonlyMap<string, ScalarType['kind'] | undefined> | undefined;

function comparisonKind(left: Kind, right: Kind): Kind {
  if (typeof left === 'object' && typeof right === 'object') {
    return new Map(
      [...new Set([...left.keys(), ...right.keys()])].map((name) => [
        name,
        scalarKind(left.get(name), right.get(name)),
      ]),
    );
  }

  return typeof left === 'object' || typeof right === 'object' ? (left ?? right) : scalarKind(left, right);
}

function scalarKind(
  left: ScalarType['kind'] | undefined,
  right: ScalarType['kind'] | undefined,
): ScalarType['kind'] | undefined {
  return left === 'decimal' || right === 'decimal' ? 'decimal' : (left ?? right);
}

function compares(condition: Extract<Condition, { kind: 'comparison' }>, scope: Scope): boolean {
  const kind = comparisonKind(kindOf(scope, condition.left), kindOf(scope, condition.right));
  const left = valueOf(scope, condition.left);
  const right = valueOf(scope, condition.right);
  const ordered = order(left, right, kind);

  switch (condition.operator) {
    case 'EQUALS':
      return equal(left, right, kind);
    case 'NOT_EQUALS':
      return !equal(left, right, kind);
    case 'LESS_THAN':
      return ordered === -1;
    case 'LESS_THAN_EQUALS':
      return ordered === -1 || ordered === 0;
    case 'GREATER_THAN':
      return ordered === 1;
    case 'GREATER_THAN_EQUALS':
      return ordered === 1 || ordered === 0;
    case 'INTERSECTS':
      return listOf(left).some((element) => listOf(right).some((other) => equal(element, other, kind)));
  }
}

function valueOf(scope: Scope, value: ConditionValue): JsonValue {
  switch (value.kind) {
    case 'parameter':
      return scope.context.parameters.get(value.parameter) ?? null;
    case 'static':
      return value.value;
    case 'objectProperty':
      return objectOf(scope.context.objects, value.parameter)?.properties.get(value.property) ?? null;
    case 'listLength': {
      const list = scope.context.parameters.get(value.parameter);

      return Array.isArray(list) ? list.length : 0;
    }
    case 'person':
      invariant(false, 'Compile gives a person value only to a comparison with EQUALS, NOT_EQUALS, or INTERSECTS.');
  }
}

function kindOf(scope: Scope, value: ConditionValue): Kind {
  switch (value.kind) {
    case 'parameter':
      return parameterKind(parameterType(scope, value.parameter));
    case 'static':
      return undefined;
    case 'objectProperty': {
      const type = parameterType(scope, value.parameter);
      const objectType = type.kind === 'object' ? scope.ontology.objectTypes.get(type.objectType) : undefined;
      const property = objectType?.properties.get(value.property);

      invariant(
        property,
        `The compiled Ontology has no Property ${value.property} for the parameter ${value.parameter}.`,
      );

      const element = property.type.kind === 'array' ? property.type.element : property.type;

      return element.kind === 'struct' ? fieldKinds(element.fields, (field) => field) : element.kind;
    }
    case 'listLength':
      return 'integer';
    case 'person':
      invariant(false, 'Compile gives a person value only to a comparison with EQUALS, NOT_EQUALS, or INTERSECTS.');
  }
}

function parameterType(scope: Scope, id: string): ParameterType {
  const parameter = scope.actionType.parameters.get(id);

  invariant(parameter, `The Action Type ${scope.actionType.apiName} has no parameter ${id}.`);

  return parameter.type;
}

const PRIMARY_KEY_KIND = 'string';

function parameterKind(type: ParameterType): Kind {
  switch (type.kind) {
    case 'list':
      return type.element.kind === 'struct'
        ? fieldKinds(type.element.fields, (field) => field.type)
        : type.element.kind;
    case 'object':
    case 'objectList':
      return PRIMARY_KEY_KIND;
    case 'struct':
      return fieldKinds(type.fields, (field) => field.type);
    default:
      return type.kind;
  }
}

function fieldKinds<T>(
  fields: ReadonlyMap<string, T>,
  typeOf: (field: T) => { readonly kind: ScalarType['kind'] },
): ReadonlyMap<string, ScalarType['kind']> {
  return new Map([...fields].map(([name, field]) => [name, typeOf(field).kind]));
}

function order(left: JsonValue, right: JsonValue, kind: Kind): Order | undefined {
  if (!isScalar(left) || !isScalar(right) || typeof kind === 'object') return undefined;

  if (typeof left === typeof right)
    return compareScalar(kind ?? (typeof left === 'number' ? 'double' : 'string'), left, right);

  return kind === 'integer' || kind === 'double' || kind === 'decimal' ? compareScalar(kind, left, right) : undefined;
}

function equal(left: JsonValue, right: JsonValue, kind: Kind): boolean {
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((element, i) => equal(element, right[i] ?? null, kind));

  if (typeof kind === 'object' && isStruct(left) && isStruct(right)) {
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].every((name) =>
      equal(fieldOf(left, name), fieldOf(right, name), kind.get(name)),
    );
  }

  const ordered = order(left, right, kind);

  return ordered === undefined ? JSON.stringify(left) === JSON.stringify(right) : ordered === 0;
}

function isScalar(value: JsonValue): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

function isStruct(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldOf(struct: { readonly [key: string]: JsonValue }, name: string): JsonValue {
  return Object.hasOwn(struct, name) ? (struct[name] ?? null) : null;
}

function listOf(value: JsonValue): readonly JsonValue[] {
  if (Array.isArray(value)) return value;

  return value === null ? [] : [value];
}
