import { ApiError, type Fallible } from '../../errors/index.ts';
import type { Edit, ObjectLocator } from '../edit.ts';
import type { LoadedObject } from '../objects.ts';
import type {
  CompiledObjectType,
  CompiledOntology,
  JsonValue,
  ParameterId,
  PropertyApiName,
  PropertyType,
  Rule,
  RuleLogic,
  RuleValue,
} from '../../ontology/index.ts';
import type { DefaultValue } from './parameters.ts';
import { objectKey, objectOf, objectTypeOf, propertyOf, refused } from './shared.ts';

export interface RuleContext {
  readonly parameters: ReadonlyMap<ParameterId, JsonValue>;
  readonly omittedDefaults: ReadonlyMap<ParameterId, DefaultValue>;
  readonly objects: ReadonlyMap<ParameterId, LoadedObject | readonly LoadedObject[]>;
  readonly now: string;
  readonly user: string;
}

export function* runRules(
  logic: RuleLogic,
  ontology: CompiledOntology,
  context: RuleContext,
): Fallible<Edit[], ApiError> {
  const edits: Edits = new Map();

  for (const rule of logic.rules) {
    switch (rule.kind) {
      case 'addObject':
        yield* addObject(edits, rule, ontology, context);

        break;
      case 'modifyObject':
        yield* modifyObject(edits, rule, ontology, context);

        break;
      case 'deleteObject':
        yield* deleteObject(edits, rule, context);

        break;
      case 'addLink':
      case 'deleteLink':
        yield* addLinkEdit(edits, rule, context);

        break;
    }
  }

  return [...edits.values()];
}

type Edits = Map<string | symbol, Edit>;

function* addObject(
  edits: Edits,
  rule: Extract<Rule, { kind: 'addObject' }>,
  ontology: CompiledOntology,
  context: RuleContext,
): Fallible<void, ApiError> {
  const edit = yield* createEdit(objectTypeOf(ontology, rule.objectType), rule.properties, context);
  const key = objectKey(edit.object);

  if (edits.has(key)) return yield refused();

  edits.set(key, edit);
}

function* modifyObject(
  edits: Edits,
  rule: Extract<Rule, { kind: 'modifyObject' }>,
  ontology: CompiledOntology,
  context: RuleContext,
): Fallible<void, ApiError> {
  const object = objectOf(context.objects, rule.object);

  if (!object) return;

  const key = objectKey(object);
  const objectType = objectTypeOf(ontology, object.objectType);
  const earlier = yield* earlierModify(edits, key);
  const properties = new Map(earlier?.properties);
  const unset = new Set(earlier?.unset);

  for (const [property, value] of rule.properties) {
    if (property === objectType.primaryKey.apiName) continue;

    if (keeps(value, rule.object, property, context)) continue;

    properties.set(property, valueOrEmpty(value, objectType, property, context, unset));
  }

  edits.set(key, { type: 'modifyObject', object: locatorOf(object), properties, ...(unset.size > 0 && { unset }) });
}

function* deleteObject(
  edits: Edits,
  rule: Extract<Rule, { kind: 'deleteObject' }>,
  context: RuleContext,
): Fallible<void, ApiError> {
  const object = objectOf(context.objects, rule.object);

  if (!object) return;

  const key = objectKey(object);

  yield* earlierModify(edits, key);

  edits.set(key, { type: 'deleteObject', object: locatorOf(object) });

  for (const [linkKey, edit] of edits) if (namesObject(edit, key)) edits.delete(linkKey);
}

function* addLinkEdit(
  edits: Edits,
  rule: Extract<Rule, { kind: 'addLink' | 'deleteLink' }>,
  context: RuleContext,
): Fallible<void, ApiError> {
  const source = objectOf(context.objects, rule.source);
  const target = objectOf(context.objects, rule.target);

  if (!source || !target) return;

  if (edits.get(objectKey(source))?.type === 'deleteObject' || edits.get(objectKey(target))?.type === 'deleteObject')
    return yield refused();

  edits.set(Symbol(), { type: rule.kind, link: rule.link, source: locatorOf(source), target: locatorOf(target) });
}

function* earlierModify(
  edits: Edits,
  key: string,
): Fallible<Extract<Edit, { type: 'modifyObject' }> | undefined, ApiError> {
  const earlier = edits.get(key);

  if (earlier && earlier.type !== 'modifyObject') return yield refused();

  return earlier;
}

export function* withoutLinksOfDeleted(edits: readonly Edit[]): Fallible<Edit[], ApiError> {
  const deleted = new Set<string>();

  for (const edit of edits) {
    if (edit.type === 'deleteObject') deleted.add(objectKey(edit.object));
    else if ([...deleted].some((key) => namesObject(edit, key))) return yield refused();
  }

  return edits.filter((edit) => ![...deleted].some((key) => namesObject(edit, key)));
}

function namesObject(edit: Edit, key: string): boolean {
  return (
    (edit.type === 'addLink' || edit.type === 'deleteLink') &&
    (objectKey(edit.source) === key || objectKey(edit.target) === key)
  );
}

function* createEdit(
  objectType: CompiledObjectType,
  mapped: ReadonlyMap<PropertyApiName, RuleValue>,
  context: RuleContext,
): Fallible<Extract<Edit, { type: 'addObject' }>, ApiError> {
  const properties = new Map<PropertyApiName, JsonValue>();
  const unset = new Set<PropertyApiName>();

  for (const [property, value] of mapped)
    properties.set(property, valueOrEmpty(value, objectType, property, context, unset));

  const primaryKey = properties.get(objectType.primaryKey.apiName);

  if (typeof primaryKey !== 'string') return yield noPrimaryKey();

  properties.delete(objectType.primaryKey.apiName);

  return {
    type: 'addObject',
    object: { objectType: objectType.apiName, primaryKey },
    properties,
    ...(unset.size > 0 && { unset }),
  };
}

function keeps(value: RuleValue, object: ParameterId, property: PropertyApiName, context: RuleContext): boolean {
  if (value.kind !== 'parameter' && value.kind !== 'structParameter') return false;

  const defaultValue = context.omittedDefaults.get(value.parameter);

  return defaultValue?.parameter === object && defaultValue.property === property;
}

function valueOf(value: RuleValue, context: RuleContext): JsonValue | undefined {
  switch (value.kind) {
    case 'parameter':
    case 'structParameter': {
      const defaultValue = context.omittedDefaults.get(value.parameter);

      return defaultValue ? valueOf(defaultValue, context) : context.parameters.get(value.parameter);
    }
    case 'static':
      return value.value;
    case 'objectProperty':
      return objectOf(context.objects, value.parameter)?.properties.get(value.property);
    case 'currentUser':
      return context.user;
    case 'currentTime':
      return context.now;
    case 'uniqueIdentifier':
      return crypto.randomUUID();
  }
}

function valueOrEmpty(
  value: RuleValue,
  objectType: CompiledObjectType,
  property: PropertyApiName,
  context: RuleContext,
  unset: Set<PropertyApiName>,
): JsonValue {
  const given = valueOf(value, context);
  const type = propertyOf(objectType, property).type;

  if (given === undefined && type.kind === 'array' && (value.kind === 'parameter' || value.kind === 'structParameter'))
    unset.add(property);
  else unset.delete(property);

  return given ?? emptyValue(type);
}

function emptyValue(type: PropertyType): JsonValue {
  if (type.kind === 'array') return [];

  if (type.kind === 'struct') return {};

  return null;
}

function locatorOf(object: LoadedObject): ObjectLocator {
  return { objectType: object.objectType, primaryKey: object.primaryKey };
}

function noPrimaryKey(): ApiError {
  return new ApiError(400, 'ApplyActionFailed', {
    originalErrorName: 'Ontos:InvalidPrimaryKeyPropertyType',
    userErrorMessage: 'The Action could not apply because of a primary key issue.',
    builderErrorMessage: 'The primary key Property requires a valid value of its declared type.',
  });
}
