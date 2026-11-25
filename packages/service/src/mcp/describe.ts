import type { ObjectPropertyType } from '@osdk/foundry.ontologies';
import { actionTypeNotFound, ApiError, invariant, type Fallible } from '../errors/index.ts';
import type {
  CompiledActionType,
  CompiledDerivedProperty,
  CompiledLink,
  CompiledObjectType,
  CompiledOntology,
  CompiledProperty,
  CompiledValueType,
  JsonObject,
  JsonValue,
  ObjectTypeApiName,
  QueryFunction,
  Status,
} from '../ontology/index.ts';
import { constraintText } from '../valueTypes/index.ts';
import { queriesByObjectType } from './queries.ts';

const MAP_LIMIT = 25_000;

interface MapStep {
  readonly actionDescriptions: boolean;
  readonly linkDescriptions: boolean;
}

const MAP_STEPS: readonly MapStep[] = [
  { actionDescriptions: true, linkDescriptions: true },
  { actionDescriptions: false, linkDescriptions: true },
];

const SHORTEST: MapStep = { actionDescriptions: false, linkDescriptions: false };

export function businessMap(ontology: CompiledOntology): JsonObject {
  for (const step of MAP_STEPS) {
    const map = mapOf(ontology, step);

    if (JSON.stringify(map).length <= MAP_LIMIT) return map;
  }

  return mapOf(ontology, SHORTEST);
}

function mapOf(ontology: CompiledOntology, step: MapStep): JsonObject {
  const actionsOf = new Map<ObjectTypeApiName, ListEntry[]>();
  const otherActions: ListEntry[] = [];

  for (const [name, actionType] of ontology.actionTypes) {
    const metadata = ontology.metadata.actionTypes[name];

    invariant(metadata, `The metadata has no Action Type ${name}.`);

    const line = {
      apiName: name,
      status: metadata.status,
      ...(step.actionDescriptions && metadata.description ? { description: metadata.description } : {}),
    };

    const named = [...objectTypesOf(actionType)].filter((objectType) => ontology.objectTypes.has(objectType));

    if (named.length === 0) otherActions.push(line);

    for (const objectType of named) actionsOf.set(objectType, [...(actionsOf.get(objectType) ?? []), line]);
  }

  const queries = queriesByObjectType(ontology);
  const queryLine = (fn: QueryFunction): ListEntry => ({ apiName: fn.apiName, ...described(fn.description) });
  const sidesOf = new Map<string, JsonObject[]>();

  for (const objectType of byApiName(ontology.objectTypes.values())) {
    for (const link of byApiName(objectType.links.values())) {
      sidesOf.set(link.linkType, [
        ...(sidesOf.get(link.linkType) ?? []),
        { objectType: objectType.apiName, link: link.apiName, cardinality: link.cardinality },
      ]);
    }
  }

  const objectTypes = byApiName(ontology.objectTypes.values()).map((objectType) => [
    objectType.apiName,
    {
      ...described(objectType.display.description),
      ...statusOf(objectType.status),
      primaryKey: objectType.primaryKey.apiName,
      titleProperty: objectType.titleKey,
      actionTypes: listOf(actionsOf.get(objectType.apiName) ?? []),
      queryFunctions: listOf((queries.byObjectType.get(objectType.apiName) ?? []).map(queryLine)),
    },
  ]);

  const linkTypes = byApiName(ontology.linkTypes.values()).map((linkType) => [
    linkType.apiName,
    {
      ...(step.linkDescriptions ? described(linkType.description) : {}),
      ...statusOf(linkType.status),
      sides: sidesOf.get(linkType.apiName) ?? [],
    },
  ]);

  return {
    objectTypes: Object.fromEntries(objectTypes),
    linkTypes: Object.fromEntries(linkTypes),
    otherActionTypes: listOf(otherActions),
    otherQueryFunctions: listOf(queries.other.map(queryLine)),
    ...(step.actionDescriptions ? {} : { detail: leftOut(step) }),
  };
}

interface ListEntry {
  readonly apiName: string;
  readonly description?: string;
  readonly status?: string;
}

function leftOut(step: MapStep): string {
  const what = step.linkDescriptions
    ? 'the descriptions of the Action Types'
    : 'the descriptions of the Action Types and the Link Types';

  return `This map leaves out ${what}. describe_object_type with an objectType and describe_action with an actionType give the detail.`;
}

function objectTypesOf(actionType: CompiledActionType): Set<ObjectTypeApiName> {
  const added =
    actionType.logic.kind === 'rules'
      ? actionType.logic.rules.flatMap((rule) => (rule.kind === 'addObject' ? [rule.objectType] : []))
      : [];

  const taken = [...actionType.parameters.values()].flatMap(({ type }) =>
    type.kind === 'object' || type.kind === 'objectList' ? [type.objectType] : [],
  );

  return new Set([...added, ...taken]);
}

function byApiName<T extends { readonly apiName: string }>(types: Iterable<T>): T[] {
  return [...types].sort((a, b) => (a.apiName < b.apiName ? -1 : 1));
}

export function actionTypeList(ontology: CompiledOntology): JsonObject {
  return { actionTypes: listOf(Object.values(ontology.metadata.actionTypes)) };
}

export function* objectTypeAnswer(ontology: CompiledOntology, apiName: string): Fallible<JsonObject, ApiError> {
  const objectType = ontology.objectTypes.get(apiName);

  const metadata = Object.hasOwn(ontology.metadata.objectTypes, apiName)
    ? ontology.metadata.objectTypes[apiName]?.objectType.properties
    : undefined;

  if (!objectType || !metadata) return yield new ApiError(404, 'ObjectTypeNotFound', { objectType: apiName });

  const properties = [...objectType.properties.values(), ...objectType.derived.values()].map((property) => {
    const dataType = metadata[property.apiName]?.dataType;

    invariant(dataType, `The metadata of ${apiName} has no Property ${property.apiName}.`);

    return [
      property.apiName,
      propertyEntry(property, propertyDataType(dataType), propertyNotes(property, objectType, ontology)),
    ];
  });

  return {
    apiName,
    ...described(objectType.display.description),
    ...statusOf(objectType.status),
    primaryKey: objectType.primaryKey.apiName,
    titleProperty: objectType.titleKey,
    properties: Object.fromEntries(properties),
    links: Object.fromEntries([...objectType.links.values()].map((link) => [link.apiName, linkEntry(link, ontology)])),
    ...notesOf(uniquenessLines(objectType)),
  };
}

function uniquenessLines(objectType: CompiledObjectType): string[] {
  if (objectType.uniqueness.length === 0) return [];

  const rules = objectType.uniqueness.map(({ properties }) => {
    const names = propertiesText(properties.map((property) => property.apiName));

    return `- Unique: no 2 ${objectType.display.pluralDisplayName} have the same ${names}.${noValueText(properties, names)}`;
  });

  return ['Uniqueness constraints:', ...rules];
}

function noValueText(properties: readonly CompiledProperty[], names: string): string {
  if (properties.every((property) => property.required)) return '';

  return properties.length === 1
    ? ` An Object with no value in ${names} never clashes.`
    : ' An Object with no value in 1 of them never clashes.';
}

export function propertiesText(apiNames: readonly string[]): string {
  const quoted = [...apiNames].sort().map((apiName) => `\`${apiName}\``);
  const last = quoted.pop();

  return quoted.length === 0 ? (last ?? '') : `${quoted.join(', ')} and ${last}`;
}

export function* actionTypeAnswer(ontology: CompiledOntology, apiName: string): Fallible<JsonObject, ApiError> {
  const metadata = Object.hasOwn(ontology.metadata.actionTypes, apiName)
    ? ontology.metadata.actionTypes[apiName]
    : undefined;

  if (!metadata) return yield actionTypeNotFound(apiName, ontology.publishedActionTypeNames.get(apiName));

  const parameters = Object.entries(metadata.parameters).map(([id, { dataType, required, description }]) => [
    id,
    { dataType: dataTypeOf(dataType), required, ...described(description) },
  ]);

  return {
    apiName,
    ...described(metadata.description),
    ...(metadata.status === 'ACTIVE' ? {} : { status: metadata.status }),
    parameters: Object.fromEntries(parameters),
  };
}

function propertyEntry(
  property: CompiledProperty | CompiledDerivedProperty,
  dataType: JsonValue,
  notes: string[],
): JsonObject {
  return {
    dataType,
    required: 'required' in property && property.required,
    ...described(property.display.description),
    ...statusOf(property.status.type),
    ...notesOf(notes),
  };
}

function propertyNotes(
  property: CompiledProperty | CompiledDerivedProperty,
  objectType: CompiledObjectType,
  ontology: CompiledOntology,
): string[] {
  if ('definition' in property) return [derivedLine(property, objectType, ontology)];

  return property.valueType ? valueTypeLines(property.valueType) : [];
}

function notesOf(lines: string[]): { notes?: string[] } {
  return lines.length === 0 ? {} : { notes: lines };
}

function valueTypeLines(valueType: CompiledValueType): string[] {
  const header = `Value type ${valueType.apiName}, version ${valueType.version}${valueType.status === 'deprecated' ? ', deprecated' : ''}.`;

  const constraints = valueType.constraints.map(
    ({ rule, failureMessage }) =>
      `Each value ${constraintText(rule)}.${failureMessage === undefined ? '' : ` When it does not: ${JSON.stringify(failureMessage)}`}`,
  );

  return [header, ...constraints];
}

type DerivedOperation = CompiledDerivedProperty['node']['operation'];

type HopSet = CompiledDerivedProperty['definition']['objectSet'];

function derivedLine(
  property: CompiledDerivedProperty,
  objectType: CompiledObjectType,
  ontology: CompiledOntology,
): string {
  const links = linksOf(property.definition.objectSet);
  const target = visibleTarget(links, objectType, ontology);

  if (!target) return 'Derived. It reads Objects that you cannot see.';

  const path = links.map((link) => `\`${link}\``).join(', then ');

  return `Derived: ${operationText(property.node.operation, target)} of ${path}. It counts only the Objects that you can see.`;
}

function visibleTarget(
  links: readonly string[],
  objectType: CompiledObjectType,
  ontology: CompiledOntology,
): CompiledObjectType | undefined {
  return links.reduce<CompiledObjectType | undefined>((from, link) => {
    const target = from?.links.get(link)?.target;

    return target === undefined ? undefined : ontology.objectTypes.get(target);
  }, objectType);
}

function linksOf(set: HopSet): string[] {
  return set.type === 'methodInput' ? [] : [...linksOf(set.objectSet), set.link];
}

function operationText(operation: DerivedOperation, target: CompiledObjectType): string {
  const objects = `the ${target.display.pluralDisplayName}`;

  switch (operation.kind) {
    case 'count':
      return `the count of ${objects}`;
    case 'get':
      return `the \`${operation.property.apiName}\` of the ${target.display.displayName}`;
    case 'sum':
    case 'avg':
    case 'min':
    case 'max':
      return `the ${AGGREGATE_WORDS[operation.kind]} of \`${operation.property.apiName}\` of ${objects}`;
    case 'exactDistinct':
      return `the count of distinct values of \`${operation.property.apiName}\` of ${objects}`;
    case 'approximateDistinct':
      return `the approximate count of distinct values of \`${operation.property.apiName}\` of ${objects}`;
    case 'approximatePercentile':
      return `the approximate percentile ${operation.percentile} of \`${operation.property.apiName}\` of ${objects}`;
    case 'collectList':
      return `the list of at most ${operation.limit} values of \`${operation.property.apiName}\` of ${objects}`;
    case 'collectSet':
      return `the set of at most ${operation.limit} distinct values of \`${operation.property.apiName}\` of ${objects}`;
  }
}

const AGGREGATE_WORDS = { sum: 'sum', avg: 'average', min: 'minimum', max: 'maximum' } as const;

function linkEntry(link: CompiledLink, ontology: CompiledOntology): JsonObject {
  const linkType = ontology.linkTypes.get(link.linkType);

  return {
    target: link.target,
    cardinality: link.cardinality,
    ...described(linkType?.description),
    ...(linkType ? statusOf(linkType.status) : {}),
  };
}

function propertyDataType(dataType: ObjectPropertyType): JsonValue {
  if (dataType.type !== 'struct') return dataTypeOf(dataType);

  return {
    type: 'struct',
    structFieldTypes: dataType.structFieldTypes.map((field) => ({
      apiName: field.apiName,
      dataType: dataTypeOf(field.dataType),
    })),
  };
}

function dataTypeOf(dataType: object): JsonValue {
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The OSDK data types are interfaces of JSON values, which TypeScript does not take as JsonValue.
  return dataType as unknown as JsonValue;
}

function described(description: string | undefined): { description?: string } {
  return description ? { description } : {};
}

function statusOf(status: Status): { status?: string } {
  return status === 'active' ? {} : { status: status.toUpperCase() };
}

function listOf(types: readonly ListEntry[]): string[] {
  return [...types]
    .sort((a, b) => (a.apiName < b.apiName ? -1 : 1))
    .map(({ apiName, description, status }) => {
      const line = description?.split('\n')[0];

      return `${apiName}${status === undefined || status === 'ACTIVE' ? '' : ` (${status.toLowerCase()})`}${line ? `: ${line}` : ''}`;
    });
}
