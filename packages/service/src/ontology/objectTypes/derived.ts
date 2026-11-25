import { invariant, type Fallible } from '../../errors/index.ts';
import type {
  CompiledDerivedProperty,
  CompiledLinkType,
  CompiledObjectType,
  CompiledProperty,
  LinkTypeApiName,
  ObjectTypeApiName,
  PropertyApiName,
  PropertyType,
} from '../compiled/index.ts';
import { CompileError } from '../compiled/stored.ts';
import { derivedNames, selectionOf, type StoredSelection } from '../derived/ir.ts';
import { parseDerived } from '../derived/parse.ts';
import { isRecord, type JsonRecord } from '../model/shape.ts';
import type { DeclaredDerived, DeclaredObjectType } from './compile.ts';

export function* splitDerived(
  datasources: unknown,
  objectType: DeclaredObjectType,
): Fallible<DeclaredObjectType, CompileError> {
  const owner = `Object Type ${objectType.apiName}`;
  const derived = new Map<PropertyApiName, DeclaredDerived>();

  for (const entry of Array.isArray(datasources) ? datasources : []) {
    const datasource = isRecord(entry) ? entry['datasource'] : undefined;

    if (!isRecord(datasource) || datasource['type'] !== 'derived') continue;

    const names = derivedNames(datasource);

    if (names.length === 0)
      return yield new CompileError(
        `${owner} has a derived datasource that maps no Property. A derived datasource maps 1 Property or more.`,
      );

    for (const name of names) {
      if (derived.has(name))
        return yield new CompileError(
          `${owner} maps the derived Property ${name} in 2 derived datasources. A derived Property has 1 definition.`,
        );

      const property = objectType.properties.get(name);

      if (!property)
        return yield new CompileError(
          `${owner} maps the derived Property ${name}, which it does not declare. Declare each derived Property in the Properties of its Object Type.`,
        );

      yield* checkDerivedUse(property, objectType, `The derived Property ${name} of ${owner}`);

      derived.set(name, { property, datasource });
    }
  }

  if (derived.size === 0) return objectType;

  return {
    ...objectType,
    properties: new Map([...objectType.properties].filter(([name]) => !derived.has(name))),
    derived,
  };
}

function* checkDerivedUse(
  property: CompiledProperty,
  objectType: DeclaredObjectType,
  subject: string,
): Fallible<void, CompileError> {
  if (property.apiName === objectType.primaryKey.apiName)
    return yield new CompileError(`${subject} is its primary key. The primary key is a stored Property.`);

  if (property.apiName === objectType.titleKey)
    return yield new CompileError(`${subject} is its title key. The title key is a stored Property.`);

  if (property.required) return yield new CompileError(`${subject} is required. A derived Property is never required.`);

  if (property.valueType)
    return yield new CompileError(
      `${subject} has the value type ${property.valueType.apiName}. A derived Property has no value type.`,
    );

  const unique = property.display.typeClasses.find(({ kind }) => kind === 'unique');

  if (unique)
    return yield new CompileError(
      `${subject} has the Uniqueness type class ${unique.name}. A derived Property is in no Uniqueness constraint.`,
    );
}

export function* attachDerived(
  objectTypes: ReadonlyMap<ObjectTypeApiName, DeclaredObjectType>,
  linkTypes: ReadonlyMap<LinkTypeApiName, CompiledLinkType>,
): Fallible<Map<ObjectTypeApiName, CompiledObjectType>, CompileError> {
  const bare = new Map<ObjectTypeApiName, CompiledObjectType>(
    [...objectTypes].map(([apiName, objectType]) => [apiName, { ...objectType, derived: new Map() }]),
  );

  const ontology = { objectTypes: bare, linkTypes };
  const attached = new Map<ObjectTypeApiName, CompiledObjectType>();

  for (const [apiName, { derived: declared }] of objectTypes) {
    const objectType = bare.get(apiName);

    invariant(objectType, `The bare Object Types have no ${apiName}.`);

    const derived = new Map<PropertyApiName, CompiledDerivedProperty>();
    const selections = new Map<JsonRecord, ReadonlyMap<PropertyApiName, StoredSelection>>();

    for (const [name, { property, datasource }] of declared) {
      const converted = selections.get(datasource) ?? (yield* selectionOf(datasource, objectType, ontology));

      selections.set(datasource, converted);

      const definition = converted.get(name);

      invariant(
        definition,
        `selectionOf gave no definition of the derived Property ${name} of Object Type ${apiName}.`,
      );

      const node = yield* derivedNode(definition, property, objectType, objectTypes, ontology);
      const { apiName: propertyName, rid, status, display, type } = property;

      derived.set(name, { apiName: propertyName, rid, status, display, type, definition, node });
    }

    attached.set(apiName, derived.size === 0 ? objectType : { ...objectType, derived });
  }

  return attached;
}

function* derivedNode(
  definition: StoredSelection,
  property: CompiledProperty,
  objectType: CompiledObjectType,
  declared: ReadonlyMap<ObjectTypeApiName, DeclaredObjectType>,
  ontology: { readonly objectTypes: ReadonlyMap<ObjectTypeApiName, CompiledObjectType> },
): Fallible<CompiledDerivedProperty['node'], CompileError> {
  const subject = `The derived Property ${property.apiName} of Object Type ${objectType.apiName}`;
  const parsed = parseDerived(definition, { objectType, property: () => undefined }, ontology, 'objectType');

  if (!parsed.ok) {
    const { refusal } = parsed;

    if (refusal.kind === 'collectLimit')
      return yield new CompileError(
        `${subject} has the collect limit ${refusal.limit}. A collect limit is from 1 to 100.`,
      );

    if (refusal.kind === 'shape')
      return yield new CompileError(`${subject} has a definition that publish refuses. ${refusal.detail}`);

    const target = targetOf(definition.objectSet, objectType, ontology);
    const name = refusal.linkOrProperty;

    if (declared.get(target)?.derived.has(name)) {
      return yield new CompileError(
        `${subject} selects the derived Property ${name} of Object Type ${target}. A derived Property selects only a stored Property.`,
      );
    }

    return yield new CompileError(
      `${subject} selects the Property ${name} of Object Type ${target}, which it does not have.`,
    );
  }

  const { node } = parsed;

  invariant(node.kind === 'selection', `parseDerived gave a ${node.kind} for the selection of ${subject}.`);

  if (typeText(property.type) !== typeText(node.type)) {
    return yield new CompileError(
      `${subject} declares the type ${typeText(property.type)}, but its definition gives ${typeText(node.type)}. A derived Property declares the type of its definition.`,
    );
  }

  return node;
}

function targetOf(
  objectSet: StoredSelection['objectSet'],
  objectType: CompiledObjectType,
  ontology: { readonly objectTypes: ReadonlyMap<ObjectTypeApiName, CompiledObjectType> },
): ObjectTypeApiName {
  if (objectSet.type === 'methodInput') return objectType.apiName;

  const from = ontology.objectTypes.get(targetOf(objectSet.objectSet, objectType, ontology));
  const target = from?.links.get(objectSet.link)?.target;

  invariant(target, `The Link side ${objectSet.link} of a converted definition has no target.`);

  return target;
}

function typeText(type: PropertyType): string {
  switch (type.kind) {
    case 'decimal':
      return `decimal with scale ${type.scale}`;
    case 'array':
      return `array of ${typeText(type.element)}`;
    case 'struct':
      return `struct of ${[...type.fields].map(([name, field]) => `${name} ${typeText(field)}`).join(', ')}`;
    default:
      return type.kind;
  }
}
