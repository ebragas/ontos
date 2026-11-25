import type {
  ActionTypeApiName,
  CompiledActionType,
  CompiledOntology,
  CompiledParameter,
  FunctionApiName,
  ObjectTypeApiName,
  OutputValueType,
  ParameterId,
  QueryFunction,
} from '../compiled/index.ts';
import { parseGrantsFile, type GrantsFile, type PermissionSlug } from '../grantsFile.ts';

export interface TypePermissions {
  readonly own: PermissionSlug;
  readonly requires: readonly PermissionSlug[];
  readonly needs: ReadonlySet<PermissionSlug>;
}

export interface PermissionIndex {
  readonly objectTypes: ReadonlyMap<ObjectTypeApiName, PermissionSlug>;
  readonly actionTypes: ReadonlyMap<ActionTypeApiName, TypePermissions>;
  readonly queryTypes: ReadonlyMap<FunctionApiName, TypePermissions>;
}

export function permissionIndex(ontology: CompiledOntology, grants: GrantsFile): PermissionIndex {
  const objectTypes = new Map<ObjectTypeApiName, PermissionSlug>();

  for (const name of ontology.objectTypes.keys()) {
    if (Object.hasOwn(grants.objectTypes, name)) objectTypes.set(name, grants.objectTypes[name] as PermissionSlug);
  }

  const permissionsOf = (own: PermissionSlug, named: ReadonlySet<ObjectTypeApiName>): TypePermissions | undefined => {
    const slugs = [...named].map((objectType) => objectTypes.get(objectType));

    if (slugs.includes(undefined)) return undefined;

    const requires = [...new Set(slugs as PermissionSlug[])].filter((slug) => slug !== own).sort();

    return { own, requires, needs: new Set([own, ...requires]) };
  };

  const actionTypes = new Map<ActionTypeApiName, TypePermissions>();

  for (const [name, action] of ontology.actionTypes) {
    const entry = Object.hasOwn(grants.actionTypes, name)
      ? permissionsOf(grants.actionTypes[name] as PermissionSlug, typesNamedBy(ontology, action))
      : undefined;

    if (entry) actionTypes.set(name, entry);
  }

  const queryTypes = new Map<FunctionApiName, TypePermissions>();
  const granted = grants.queryTypes ?? {};

  for (const [name, fn] of ontology.functions) {
    const entry =
      fn.kind === 'query' && Object.hasOwn(granted, name)
        ? permissionsOf(granted[name] as PermissionSlug, typesNamedByQuery(fn))
        : undefined;

    if (entry) queryTypes.set(name, entry);
  }

  return { objectTypes, actionTypes, queryTypes };
}

export function loadPermissionIndex(ontology: CompiledOntology, stored: unknown): PermissionIndex | null {
  const parsed = parseGrantsFile(stored);

  return 'grants' in parsed ? permissionIndex(ontology, parsed.grants) : null;
}

export function typesNamedBy(ontology: CompiledOntology, action: CompiledActionType): ReadonlySet<ObjectTypeApiName> {
  const named = new Set(typesOfParameters(action.parameters));
  const objectTypeOf = (parameter: ParameterId) => typeOfParameter(action.parameters.get(parameter));

  const linkTypeEnds = (linkType: string) => {
    const storage = ontology.linkTypes.get(linkType)?.storage;

    if (storage?.kind === 'foreignKey') named.add(storage.manySide).add(storage.oneSide);

    if (storage?.kind === 'joinTable') named.add(storage.a.objectType).add(storage.b.objectType);
  };

  if (action.logic.kind === 'function') {
    const fn = ontology.functions.get(action.logic.function);
    const provenance = fn?.kind === 'edit' ? fn.provenance : undefined;

    for (const objectType of provenance?.objectTypes ?? []) named.add(objectType);

    for (const linkType of provenance?.linkTypes ?? []) linkTypeEnds(linkType);

    return named;
  }

  for (const rule of action.logic.rules) {
    if (rule.kind === 'addObject') named.add(rule.objectType);

    if (rule.kind === 'addLink' || rule.kind === 'deleteLink') {
      const sourceType = objectTypeOf(rule.source);
      const link = sourceType === undefined ? undefined : ontology.objectTypes.get(sourceType)?.links.get(rule.link);

      if (link) linkTypeEnds(link.linkType);
    }
  }

  return named;
}

function typesNamedByQuery(fn: QueryFunction): ReadonlySet<ObjectTypeApiName> {
  const named = new Set(typesOfParameters(fn.parameters));

  const walk = (type: OutputValueType): void => {
    if (type.kind === 'object') named.add(type.objectType);

    if (type.kind === 'list') walk(type.element);

    if (type.kind === 'struct') for (const field of type.fields.values()) walk(field.type);
  };

  walk(fn.output.type);

  return named;
}

function typeOfParameter(parameter: CompiledParameter | undefined): ObjectTypeApiName | undefined {
  const type = parameter?.type;

  return type?.kind === 'object' || type?.kind === 'objectList' ? type.objectType : undefined;
}

function typesOfParameters(parameters: ReadonlyMap<ParameterId, CompiledParameter>): ObjectTypeApiName[] {
  return [...parameters.values()].flatMap((parameter) => typeOfParameter(parameter) ?? []);
}
