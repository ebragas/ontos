import type { CompiledLinkType, CompiledObjectType, CompiledOntology, ObjectTypeApiName } from '../compiled/index.ts';
import type { PermissionSlug } from '../grantsFile.ts';
import type { PermissionIndex, TypePermissions } from './permissionIndex.ts';

export function forPermissions(
  compiled: CompiledOntology,
  index: PermissionIndex | null,
  permissions: ReadonlySet<PermissionSlug>,
): CompiledOntology {
  if (permissions.has('*')) return compiled;

  const keepObjectType = (name: string): boolean => {
    const permission = index?.objectTypes.get(name);

    return permission !== undefined && permissions.has(permission);
  };

  const holdsAll = (entry: TypePermissions | undefined): boolean =>
    entry !== undefined &&
    permissions.has(entry.own) &&
    [...entry.needs].every((permission) => permissions.has(permission));

  const keepActionType = (name: string): boolean => holdsAll(index?.actionTypes.get(name));
  const keepQueryType = (name: string): boolean => holdsAll(index?.queryTypes.get(name));
  const objectTypes = new Map<ObjectTypeApiName, CompiledObjectType>();

  for (const [name, objectType] of compiled.objectTypes) {
    if (keepObjectType(name))
      objectTypes.set(name, {
        ...objectType,
        links: new Map([...objectType.links].filter(([, link]) => keepObjectType(link.target))),
      });
  }

  const linkTypes = new Map([...compiled.linkTypes].filter(([, linkType]) => sidesOf(linkType).every(keepObjectType)));
  const actionTypes = new Map([...compiled.actionTypes].filter(([name]) => keepActionType(name)));

  const functionNames = new Set(
    [...actionTypes.values()].flatMap(({ logic }) => (logic.kind === 'function' ? [logic.function] : [])),
  );

  const functions = new Map(
    [...compiled.functions].filter(([name, fn]) =>
      fn.kind === 'edit' ? functionNames.has(name) : keepQueryType(name),
    ),
  );

  const publishedActionTypeNames = new Map(
    [...compiled.publishedActionTypeNames].filter(([, name]) => actionTypes.has(name)),
  );

  const { metadata } = compiled;

  const keptObjectTypes = Object.fromEntries(
    Object.entries(metadata.objectTypes)
      .filter(([name]) => keepObjectType(name))
      .map(([name, full]) => [
        name,
        { ...full, linkTypes: full.linkTypes.filter((side) => keepObjectType(side.objectTypeApiName)) },
      ]),
  );

  const usedValueTypes = new Set(
    Object.values(keptObjectTypes).flatMap(({ objectType }) =>
      Object.values(objectType.properties).flatMap(({ valueTypeApiName }) =>
        valueTypeApiName === undefined ? [] : [valueTypeApiName],
      ),
    ),
  );

  return {
    ...compiled,
    metadata: {
      ...metadata,
      objectTypes: keptObjectTypes,
      valueTypes: Object.fromEntries(Object.entries(metadata.valueTypes).filter(([name]) => usedValueTypes.has(name))),
      actionTypes: Object.fromEntries(Object.entries(metadata.actionTypes).filter(([name]) => keepActionType(name))),
      actionTypesFullMetadata: Object.fromEntries(
        Object.entries(metadata.actionTypesFullMetadata).filter(([name]) => keepActionType(name)),
      ),
      queryTypes: Object.fromEntries(Object.entries(metadata.queryTypes).filter(([name]) => keepQueryType(name))),
    },
    objectTypes,
    linkTypes,
    actionTypes,
    publishedActionTypeNames,
    functions,
  };
}

function sidesOf({ storage }: CompiledLinkType): readonly ObjectTypeApiName[] {
  return storage.kind === 'foreignKey'
    ? [storage.manySide, storage.oneSide]
    : [storage.a.objectType, storage.b.objectType];
}
