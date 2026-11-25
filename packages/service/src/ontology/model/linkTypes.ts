import { type Fallible } from '../../errors/index.ts';
import type {
  CompiledLink,
  CompiledLinkType,
  CompiledObjectType,
  CompiledProperty,
  JoinTable,
  LinkSideApiName,
  LinkTypeApiName,
  ObjectTypeApiName,
} from '../compiled/index.ts';
import { CompileError } from '../compiled/stored.ts';
import { storedProperty } from '../derived/ir.ts';
import { linkTypeRid } from '../rids.ts';
import { checkLinkSideApiName, checkLinkTypeApiName } from './memberNames.ts';
import { camelCaseOf } from './names.ts';
import { optionalString, status } from './optional.ts';
import { array, isRecord, record, string, tag, type JsonRecord } from './shape.ts';
import { joinTableName, snakeCase } from './tableNames.ts';

type ObjectTypes = ReadonlyMap<ObjectTypeApiName, CompiledObjectType<unknown>>;

type LinkTypeBase = Pick<CompiledLinkType, 'apiName' | 'rid' | 'status' | 'description'>;

interface Side {
  readonly on: ObjectTypeApiName;
  readonly link: CompiledLink;
}

export function* compileLinkTypes<Derived>(
  linkTypes: JsonRecord,
  objectTypes: ReadonlyMap<ObjectTypeApiName, CompiledObjectType<Derived>>,
  namespace: string,
): Fallible<
  {
    linkTypes: Map<LinkTypeApiName, CompiledLinkType>;
    objectTypes: Map<ObjectTypeApiName, CompiledObjectType<Derived>>;
  },
  CompileError
> {
  const compiled = new Map<LinkTypeApiName, CompiledLinkType>();
  const links = new Map<ObjectTypeApiName, Map<LinkSideApiName, CompiledLink>>();

  for (const [key, value] of Object.entries(linkTypes)) {
    const path = `ontology.linkTypes.${key}`;

    const { linkType, sides } = yield* compileLinkType(
      yield* record((yield* record(value, path))['linkType'], `${path}.linkType`),
      `${path}.linkType`,
      objectTypes,
      namespace,
    );

    if (compiled.has(linkType.apiName)) {
      return yield new CompileError(
        `2 Link Types have the API name ${linkType.apiName}. A Link Type API name is unique.`,
      );
    }

    compiled.set(linkType.apiName, linkType);

    for (const side of sides) yield* addSide(links, side, objectTypes);
  }

  const withLinks = new Map<ObjectTypeApiName, CompiledObjectType<Derived>>();

  for (const [apiName, objectType] of objectTypes) {
    withLinks.set(apiName, {
      ...objectType,
      links: links.get(apiName) ?? new Map(),
      joinTables: joinTablesOf(compiled, apiName),
    });
  }

  return { linkTypes: compiled, objectTypes: withLinks };
}

function joinTablesOf(
  linkTypes: ReadonlyMap<LinkTypeApiName, CompiledLinkType>,
  objectType: ObjectTypeApiName,
): JoinTable[] {
  const tables: JoinTable[] = [];

  for (const { storage } of linkTypes.values()) {
    if (storage.kind !== 'joinTable') continue;

    const columns = [storage.a, storage.b].filter((side) => side.objectType === objectType).map((side) => side.column);

    if (columns.length > 0) tables.push({ table: storage.table, columns });
  }

  return tables;
}

function* addSide(
  links: Map<ObjectTypeApiName, Map<LinkSideApiName, CompiledLink>>,
  side: Side,
  objectTypes: ObjectTypes,
): Fallible<void, CompileError> {
  const name = side.link.apiName;
  const on = objectTypes.get(side.on);

  if (on?.properties.has(name) || on?.derived.has(name)) {
    return yield new CompileError(
      `The Link side ${name} on Object Type ${side.on} has the API name of a Property of it. A Link side API name is different from each Property API name on its Object Type.`,
    );
  }

  const onObjectType = links.get(side.on) ?? new Map<LinkSideApiName, CompiledLink>();

  if (onObjectType.has(name)) {
    return yield new CompileError(
      `2 Link sides on Object Type ${side.on} have the API name ${name}. A Link side API name is unique across the Link Types on its Object Type.`,
    );
  }

  onObjectType.set(name, side.link);

  links.set(side.on, onObjectType);
}

function* compileLinkType(
  linkType: JsonRecord,
  path: string,
  objectTypes: ObjectTypes,
  namespace: string,
): Fallible<{ linkType: CompiledLinkType; sides: Side[] }, CompileError> {
  const id = yield* string(linkType['id'], `${path}.id`);
  const apiName = yield* apiNameOf(id);

  yield* checkLinkTypeApiName(apiName);

  const owner = `Link Type ${apiName}`;
  const linkStatus = yield* status(linkType['status'], `${path}.status`, owner);

  const definitionPath = `${path}.definition`;
  const kind = yield* tag(linkType['definition'], definitionPath);

  const definition = yield* record(
    (yield* record(linkType['definition'], definitionPath))[kind],
    `${definitionPath}.${kind}`,
  );

  const description = yield* optionalString(linkType['description'], `${path}.description`);

  const base: LinkTypeBase = {
    apiName,
    rid: linkTypeRid(namespace, id),
    status: linkStatus,
    ...(description === undefined ? {} : { description }),
  };

  switch (kind) {
    case 'oneToMany':
      return yield* foreignKeyLink(definition, `${definitionPath}.oneToMany`, base, objectTypes);
    case 'manyToMany':
      return yield* joinTableLink(definition, `${definitionPath}.manyToMany`, base, objectTypes);
    case 'intermediary':
      return yield new CompileError(
        `${owner} is an object-backed Link Type (the @osdk/maker intermediary shape), which V1 does not have. Use a many-to-many Link Type.`,
      );
    default:
      return yield new CompileError(
        `${owner} has the definition ${kind}, which V1 does not have. A Link Type is one-to-many or many-to-many.`,
      );
  }
}

function* apiNameOf(id: string): Fallible<LinkTypeApiName, CompileError> {
  if (id.startsWith('ri.')) {
    return yield new CompileError(
      `The Link Type ID ${id} is a Link Type RID, not the kebab case of a Link Type API name. V1 does not accept a Link Type RID.`,
    );
  }

  const apiName = camelCaseOf(id);

  if (kebabCase(apiName) !== id) {
    return yield new CompileError(
      `The Link Type ID ${id} differs from the kebab case of its API name ${apiName}. The ID is the kebab case API name, such as project-to-tasks for projectToTasks.`,
    );
  }

  return apiName;
}

export function kebabCase(apiName: string): string {
  return apiName
    .replace(/_/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

function* foreignKeyLink(
  definition: JsonRecord,
  path: string,
  base: LinkTypeBase,
  objectTypes: ObjectTypes,
): Fallible<{ linkType: CompiledLinkType; sides: Side[] }, CompileError> {
  const { apiName } = base;
  const owner = `Link Type ${apiName}`;
  const hint = yield* string(definition['cardinalityHint'], `${path}.cardinalityHint`);

  if (hint === 'ONE_TO_ONE') {
    return yield new CompileError(
      `${owner} is a one-to-one Link Type, which V1 does not have. A one-to-many Link Type covers it.`,
    );
  }

  if (hint !== 'ONE_TO_MANY')
    return yield new CompileError(
      `${owner} has the cardinality hint ${hint}. A Link Type is one-to-many or many-to-many.`,
    );

  const oneSide = yield* objectType(
    definition['objectTypeRidOneSide'],
    `${path}.objectTypeRidOneSide`,
    objectTypes,
    owner,
  );

  const manySide = yield* objectType(
    definition['objectTypeRidManySide'],
    `${path}.objectTypeRidManySide`,
    objectTypes,
    owner,
  );

  const oneSideMetadata = yield* sideMetadata(
    definition['oneToManyLinkMetadata'],
    `${path}.oneToManyLinkMetadata`,
    apiName,
  );

  const manySideMetadata = yield* sideMetadata(
    definition['manyToOneLinkMetadata'],
    `${path}.manyToOneLinkMetadata`,
    apiName,
  );

  const mappingPath = `${path}.oneSidePrimaryKeyToManySidePropertyMapping`;
  const mappings = yield* array(definition['oneSidePrimaryKeyToManySidePropertyMapping'], mappingPath);

  if (mappings.length !== 1)
    return yield new CompileError(
      `${owner} has ${mappings.length} foreign key mappings. A one-to-many Link Type has 1 foreign key Property.`,
    );

  const mapping = yield* record(mappings[0], `${mappingPath}.0`);
  const from = yield* record(mapping['from'], `${mappingPath}.0.from`);
  const to = yield* record(mapping['to'], `${mappingPath}.0.to`);
  const primaryKeyName = yield* string(from['apiName'], `${mappingPath}.0.from.apiName`);
  const foreignKeyName = yield* string(to['apiName'], `${mappingPath}.0.to.apiName`);

  if (
    (yield* string(from['object'], `${mappingPath}.0.from.object`)) !== oneSide.apiName ||
    primaryKeyName !== oneSide.primaryKey.apiName
  ) {
    return yield new CompileError(
      `The foreign key mapping of ${owner} does not start at the primary key ${oneSide.primaryKey.apiName} of ${oneSide.apiName}.`,
    );
  }

  if ((yield* string(to['object'], `${mappingPath}.0.to.object`)) !== manySide.apiName) {
    return yield new CompileError(
      `The foreign key Property ${foreignKeyName} of ${owner} is not on the many side ${manySide.apiName}.`,
    );
  }

  const foreignKey = yield* storedProperty(manySide, foreignKeyName, `the foreign key of Link Type ${base.apiName}`);

  if (!foreignKey)
    return yield new CompileError(
      `The foreign key Property ${foreignKeyName} of ${owner} is not a Property of ${manySide.apiName}.`,
    );

  yield* checkForeignKeyType(foreignKey, oneSide.primaryKey, owner);

  return {
    linkType: {
      ...base,
      storage: {
        kind: 'foreignKey',
        manySide: manySide.apiName,
        property: foreignKey,
        oneSide: oneSide.apiName,
        table: manySide.table,
      },
    },
    sides: [
      {
        on: oneSide.apiName,
        link: {
          ...oneSideMetadata,
          linkType: apiName,
          target: manySide.apiName,
          cardinality: 'MANY',
          via: { kind: 'foreignKeyOnTarget', column: foreignKey.column },
        },
      },
      {
        on: manySide.apiName,
        link: {
          ...manySideMetadata,
          linkType: apiName,
          target: oneSide.apiName,
          cardinality: 'ONE',
          via: { kind: 'foreignKeyHere', column: foreignKey.column },
        },
      },
    ],
  };
}

function* checkForeignKeyType(
  foreignKey: CompiledProperty,
  primaryKey: CompiledProperty,
  owner: string,
): Fallible<void, CompileError> {
  if (JSON.stringify(foreignKey.type) !== JSON.stringify(primaryKey.type)) {
    return yield new CompileError(
      `The foreign key Property ${foreignKey.apiName} of ${owner} has the type ${foreignKey.type.kind}. A foreign key Property has the base type of the primary key ${primaryKey.apiName} that it points to: ${primaryKey.type.kind}.`,
    );
  }
}

function* joinTableLink(
  definition: JsonRecord,
  path: string,
  base: LinkTypeBase,
  objectTypes: ObjectTypes,
): Fallible<{ linkType: CompiledLinkType; sides: Side[] }, CompileError> {
  const { apiName } = base;
  const owner = `Link Type ${apiName}`;
  const a = yield* objectType(definition['objectTypeRidA'], `${path}.objectTypeRidA`, objectTypes, owner);
  const b = yield* objectType(definition['objectTypeRidB'], `${path}.objectTypeRidB`, objectTypes, owner);

  const aMetadata = yield* sideMetadata(
    definition['objectTypeAToBLinkMetadata'],
    `${path}.objectTypeAToBLinkMetadata`,
    apiName,
  );

  const bMetadata = yield* sideMetadata(
    definition['objectTypeBToALinkMetadata'],
    `${path}.objectTypeBToALinkMetadata`,
    apiName,
  );

  const table = joinTableName(apiName);
  const aColumn = snakeCase(`a_${a.primaryKey.apiName}`);
  const bColumn = snakeCase(`b_${b.primaryKey.apiName}`);

  return {
    linkType: {
      ...base,
      storage: {
        kind: 'joinTable',
        table,
        a: { objectType: a.apiName, column: aColumn },
        b: { objectType: b.apiName, column: bColumn },
      },
    },
    sides: [
      {
        on: a.apiName,
        link: {
          ...aMetadata,
          linkType: apiName,
          target: b.apiName,
          cardinality: 'MANY',
          via: { kind: 'joinTable', table, sourceColumn: aColumn, targetColumn: bColumn },
        },
      },
      {
        on: b.apiName,
        link: {
          ...bMetadata,
          linkType: apiName,
          target: a.apiName,
          cardinality: 'MANY',
          via: { kind: 'joinTable', table, sourceColumn: bColumn, targetColumn: aColumn },
        },
      },
    ],
  };
}

function* objectType(
  value: unknown,
  path: string,
  objectTypes: ObjectTypes,
  owner: string,
): Fallible<CompiledObjectType<unknown>, CompileError> {
  const apiName = yield* string(value, path);
  const found = objectTypes.get(apiName);

  if (!found)
    return yield new CompileError(`${owner} links the Object Type ${apiName}, which the Ontology does not have.`);

  return found;
}

function* sideMetadata(
  value: unknown,
  path: string,
  linkType: LinkTypeApiName,
): Fallible<Pick<CompiledLink, 'apiName' | 'displayName'>, CompileError> {
  const metadata = yield* record(value, path);
  const apiName = metadata['apiName'];

  if (typeof apiName !== 'string' || apiName.length === 0)
    return yield new CompileError(`A Link side of Link Type ${linkType} has no API name.`);

  yield* checkLinkSideApiName(apiName, linkType);

  yield* checkNoSideFeatures(metadata, path, `The Link side ${apiName} of Link Type ${linkType}`);

  const displayPath = `${path}.displayMetadata`;

  return {
    apiName,
    displayName: yield* string(
      (yield* record(metadata['displayMetadata'], displayPath))['displayName'],
      `${displayPath}.displayName`,
    ),
  };
}

function* checkNoSideFeatures(metadata: JsonRecord, path: string, owner: string): Fallible<void, CompileError> {
  const display = metadata['displayMetadata'];
  const visibility = isRecord(display) ? display['visibility'] : undefined;

  if (visibility !== undefined && visibility !== null && visibility !== 'NORMAL') {
    const label =
      typeof visibility === 'string' || typeof visibility === 'number' || typeof visibility === 'boolean'
        ? String(visibility)
        : JSON.stringify(visibility);

    return yield new CompileError(`${owner} has the visibility ${label}. V1 has no visibility on Link Types.`);
  }

  const typeClasses = metadata['typeClasses'];

  if (
    typeClasses !== undefined &&
    typeClasses !== null &&
    (yield* array(typeClasses, `${path}.typeClasses`)).length > 0
  ) {
    return yield new CompileError(`${owner} has type classes. V1 has no type classes on Link Types.`);
  }
}
