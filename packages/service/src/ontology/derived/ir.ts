import { each, settle, type Fallible } from '../../errors/index.ts';
import type {
  CompiledLink,
  CompiledLinkType,
  CompiledObjectType,
  CompiledOntology,
  CompiledProperty,
  LinkSideApiName,
  PropertyApiName,
} from '../compiled/index.ts';
import { CompileError } from '../compiled/stored.ts';
import { camelCaseOf } from '../model/names.ts';
import { array, isRecord, record, string, tag, type JsonRecord } from '../model/shape.ts';

type StoredMethodSet =
  | { readonly type: 'methodInput' }
  | { readonly type: 'searchAround'; readonly objectSet: StoredMethodSet; readonly link: LinkSideApiName };

type StoredOperation =
  | { readonly type: 'count' }
  | {
      readonly type: 'get' | 'sum' | 'avg' | 'min' | 'max' | 'exactDistinct' | 'approximateDistinct';
      readonly selectedPropertyApiName: PropertyApiName;
    }
  | {
      readonly type: 'collectList' | 'collectSet';
      readonly selectedPropertyApiName: PropertyApiName;
      readonly limit: number;
    };

export interface StoredSelection {
  readonly type: 'selection';
  readonly objectSet: StoredMethodSet;
  readonly operation: StoredOperation;
}

export function* sideOf(
  objectType: CompiledObjectType,
  linkType: CompiledLinkType,
  side: 'SOURCE' | 'TARGET',
): Fallible<LinkSideApiName, CompileError> {
  const { storage } = linkType;
  const source = side === 'SOURCE';

  const start =
    storage.kind === 'foreignKey'
      ? source
        ? storage.oneSide
        : storage.manySide
      : source
        ? storage.a.objectType
        : storage.b.objectType;

  if (start !== objectType.apiName) {
    return yield new CompileError(
      `Link Type ${linkType.apiName} does not connect to Object Type ${objectType.apiName} on the side ${side}. The ${side} side is Object Type ${start}.`,
    );
  }

  const startsHere = (link: CompiledLink): boolean =>
    storage.kind === 'foreignKey'
      ? link.via.kind === (source ? 'foreignKeyOnTarget' : 'foreignKeyHere')
      : link.via.kind === 'joinTable' && link.via.sourceColumn === (source ? storage.a.column : storage.b.column);

  const found = [...objectType.links.values()].find((link) => link.linkType === linkType.apiName && startsHere(link));

  if (!found)
    return yield new CompileError(
      `Object Type ${objectType.apiName} has no Link side of Link Type ${linkType.apiName} on the side ${side}.`,
    );

  return found.apiName;
}

function* hopOf(
  step: { linkType: string; side: 'SOURCE' | 'TARGET' },
  current: CompiledObjectType,
  ontology: Pick<CompiledOntology, 'objectTypes' | 'linkTypes'>,
): Fallible<{ sideName: LinkSideApiName; next: CompiledObjectType }, CompileError> {
  const linkType = ontology.linkTypes.get(step.linkType) ?? ontology.linkTypes.get(camelCaseOf(step.linkType));

  if (!linkType) return yield new CompileError(`The Ontology has no Link Type ${step.linkType}.`);

  const sideName = yield* sideOf(current, linkType, step.side);
  const side = current.links.get(sideName);
  const next = side ? ontology.objectTypes.get(side.target) : undefined;

  if (!side || !next)
    return yield new CompileError(`The Link side ${sideName} of Object Type ${current.apiName} has no target.`);

  return { sideName, next };
}

export function* selectionOf(
  datasource: JsonRecord,
  objectType: CompiledObjectType,
  ontology: Pick<CompiledOntology, 'objectTypes' | 'linkTypes'>,
): Fallible<ReadonlyMap<PropertyApiName, StoredSelection>, CompileError> {
  const owner = `Object Type ${objectType.apiName}`;

  if ((yield* tag(datasource, 'datasource')) !== 'derived')
    return yield new CompileError(`A datasource of ${owner} is not a derived datasource.`);

  const definitionPath = `${owner} derived.definition`;

  const definition = yield* record(
    (yield* record(datasource['derived'], `${owner} derived`))['definition'],
    definitionPath,
  );

  const kind = yield* tag(definition, definitionPath);
  const names = derivedNames(datasource).join(', ');

  if (kind === 'deleted')
    return yield new CompileError(
      `The derived Properties ${names} of ${owner} have a deleted definition. A derived definition names Link Types that exist.`,
    );

  if (kind !== 'linkedProperties' && kind !== 'aggregatedProperties')
    return yield new CompileError(
      `${owner} has the derived definition ${kind}. A derived definition is linkedProperties or aggregatedProperties.`,
    );

  const body = yield* record(definition[kind], `${definitionPath}.${kind}`);
  const mapping = yield* record(body['propertyTypeMapping'], `${definitionPath}.${kind}.propertyTypeMapping`);

  const link = yield* chainOf(
    yield* record(body['linkDefinition'], `${definitionPath}.${kind}.linkDefinition`),
    `${definitionPath}.${kind}.linkDefinition`,
  );

  if (link.length === 0)
    return yield new CompileError(
      `The derived Properties ${names} of ${owner} have no hop. A derived definition has at least 1 hop.`,
    );

  let objectSet: StoredMethodSet = { type: 'methodInput' };
  let current = objectType;

  for (const step of link) {
    const hop = settle(hopOf(step, current, ontology));

    if (!hop.ok)
      return yield new CompileError(
        `The derived Properties ${names} of ${owner} have a hop that does not connect. ${hop.error.message}`,
      );

    objectSet = { type: 'searchAround', objectSet, link: hop.value.sideName };

    current = hop.value.next;
  }

  const selections = new Map<PropertyApiName, StoredSelection>();

  for (const [name, value] of Object.entries(mapping)) {
    const path = `${definitionPath}.${kind}.propertyTypeMapping.${name}`;

    selections.set(name, { type: 'selection', objectSet, operation: yield* operationOf(kind, value, path) });
  }

  return selections;
}

export function derivedNames(datasource: JsonRecord): string[] {
  const definition = isRecord(datasource['derived']) ? datasource['derived']['definition'] : undefined;

  if (!isRecord(definition) || typeof definition['type'] !== 'string') return [];

  const body = definition[definition['type']];

  if (!isRecord(body)) return [];

  if (definition['type'] === 'deleted')
    return Array.isArray(body['propertyTypes']) ? body['propertyTypes'].filter((name) => typeof name === 'string') : [];

  return isRecord(body['propertyTypeMapping']) ? Object.keys(body['propertyTypeMapping']) : [];
}

export function* storedProperty(
  objectType: Pick<CompiledObjectType<unknown>, 'apiName' | 'properties' | 'derived'>,
  apiName: PropertyApiName,
  use: string,
): Fallible<CompiledProperty | undefined, CompileError> {
  if (objectType.derived.has(apiName)) {
    return yield new CompileError(
      `The derived Property ${apiName} of Object Type ${objectType.apiName} cannot be ${use}. A derived Property is computed at read time.`,
    );
  }

  return objectType.properties.get(apiName);
}

function* chainOf(
  linkDefinition: JsonRecord,
  path: string,
): Fallible<{ linkType: string; side: 'SOURCE' | 'TARGET' }[], CompileError> {
  const kind = yield* tag(linkDefinition, path);
  const body = yield* record(linkDefinition[kind], `${path}.${kind}`);

  if (kind === 'linkTypeLink') return [yield* stepOf(body, `${path}.${kind}`)];

  if (kind !== 'multiHopLink')
    return yield new CompileError(
      `The IR field ${path} has the link definition ${kind}. A link definition is linkTypeLink or multiHopLink.`,
    );

  return yield* each(yield* array(body['steps'], `${path}.${kind}.steps`), function* (step, index): Fallible<
    { linkType: string; side: 'SOURCE' | 'TARGET' },
    CompileError
  > {
    const stepPath = `${path}.${kind}.steps.${index}`;

    if ((yield* tag(step, stepPath)) !== 'searchAround')
      return yield new CompileError(`The IR field ${stepPath} is not a searchAround step.`);

    return yield* stepOf(
      yield* record((yield* record(step, stepPath))['searchAround'], `${stepPath}.searchAround`),
      `${stepPath}.searchAround`,
    );
  });
}

function* stepOf(
  step: JsonRecord,
  path: string,
): Fallible<{ linkType: string; side: 'SOURCE' | 'TARGET' }, CompileError> {
  const identifier = yield* record(step['linkTypeIdentifier'], `${path}.linkTypeIdentifier`);
  const side = yield* string(step['linkTypeSide'], `${path}.linkTypeSide`);

  if (side !== 'SOURCE' && side !== 'TARGET')
    return yield new CompileError(`The IR field ${path}.linkTypeSide is ${side}. A side is SOURCE or TARGET.`);

  return { linkType: yield* string(identifier['linkType'], `${path}.linkTypeIdentifier.linkType`), side };
}

function* propertyOf(identifier: unknown, path: string): Fallible<PropertyApiName, CompileError> {
  return yield* string((yield* record(identifier, path))['propertyType'], `${path}.propertyType`);
}

function* operationOf(
  kind: 'linkedProperties' | 'aggregatedProperties',
  value: unknown,
  path: string,
): Fallible<StoredOperation, CompileError> {
  if (kind === 'linkedProperties') return { type: 'get', selectedPropertyApiName: yield* propertyOf(value, path) };

  const aggregation = yield* tag(value, path);
  const body = (yield* record(value, path))[aggregation];

  switch (aggregation) {
    case 'count':
      return { type: 'count' };
    case 'sum':
    case 'avg':
    case 'min':
    case 'max':
      return { type: aggregation, selectedPropertyApiName: yield* propertyOf(body, `${path}.${aggregation}`) };
    case 'approximateCardinality':
      return {
        type: 'approximateDistinct',
        selectedPropertyApiName: yield* propertyOf(body, `${path}.${aggregation}`),
      };
    case 'exactCardinality':
      return { type: 'exactDistinct', selectedPropertyApiName: yield* propertyOf(body, `${path}.${aggregation}`) };
    case 'collectList':
    case 'collectSet': {
      const collected = yield* record(body, `${path}.${aggregation}`);
      const limit = collected['limit'];

      if (typeof limit !== 'number')
        return yield new CompileError(`The IR field ${path}.${aggregation}.limit is not a number.`);

      return {
        type: aggregation,
        selectedPropertyApiName: yield* propertyOf(
          collected['linkedProperty'],
          `${path}.${aggregation}.linkedProperty`,
        ),
        limit,
      };
    }
    default:
      return yield new CompileError(
        `The IR field ${path} has the aggregation ${aggregation}. An aggregation is count, sum, avg, min, max, approximateCardinality, exactCardinality, collectList, or collectSet.`,
      );
  }
}
