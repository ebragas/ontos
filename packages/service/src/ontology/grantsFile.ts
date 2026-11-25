import { personAttributesOf } from './access/personAttributes.ts';
import type {
  ActionTypeApiName,
  FunctionApiName,
  ObjectTypeApiName,
  PersonAttributeDeclaration,
  PersonAttributeName,
} from './compiled/index.ts';
import { isRecord } from './model/shape.ts';

export type PermissionSlug = string;

export const SERVICE_PERMISSIONS: readonly PermissionSlug[] = ['ontology:install'];

export const SERVICE_PERMISSION_DESCRIPTIONS: Readonly<Record<PermissionSlug, string>> = {
  'ontology:install': 'Install an Ontology of a product in the Organization',
};

export const SERVICE_PREFIX = 'ontology:';

export interface GrantsFile {
  readonly permissions: Readonly<Record<PermissionSlug, { readonly description: string }>>;
  readonly objectTypes: Readonly<Record<ObjectTypeApiName, PermissionSlug>>;
  readonly actionTypes: Readonly<Record<ActionTypeApiName, PermissionSlug>>;
  readonly defaultRoles: Readonly<Record<string, readonly PermissionSlug[]>>;
  readonly queryTypes?: Readonly<Record<FunctionApiName, PermissionSlug>>;
  readonly personAttributes?: Readonly<Record<PersonAttributeName, PersonAttributeDeclaration>>;
}

type ParsedGrantsFile = { readonly grants: GrantsFile } | { readonly problem: string };

const REQUIRED = ['permissions', 'objectTypes', 'actionTypes', 'defaultRoles'] as const;
const KEYS: readonly string[] = [...REQUIRED, 'queryTypes', 'personAttributes'];

export function parseGrantsFile(value: unknown): ParsedGrantsFile {
  if (!isRecord(value)) return { problem: 'The grants file is not a JSON object.' };

  const unknownKey = Object.keys(value).find((key) => !KEYS.includes(key));

  if (unknownKey !== undefined)
    return {
      problem: `The grants file has the key ${unknownKey}. Its keys are permissions, objectTypes, actionTypes, defaultRoles, queryTypes, and personAttributes.`,
    };

  const missing = REQUIRED.find((key) => !Object.hasOwn(value, key));

  if (missing !== undefined) return { problem: `The grants file has no key ${missing}.` };

  const { permissions, objectTypes, actionTypes, defaultRoles } = value;
  const isString = (each: unknown): each is string => typeof each === 'string';

  if (!isRecord(permissions)) return { problem: 'permissions is not a JSON object.' };

  for (const [slug, permission] of Object.entries(permissions)) {
    if (
      !isRecord(permission) ||
      Object.keys(permission).join() !== 'description' ||
      !isString(permission['description'])
    ) {
      return { problem: `The permission ${slug} is not an object with only the String description.` };
    }
  }

  const maps = {
    objectTypes,
    actionTypes,
    ...(Object.hasOwn(value, 'queryTypes') ? { queryTypes: value['queryTypes'] } : {}),
  };

  for (const [key, map] of Object.entries(maps)) {
    if (!isRecord(map)) return { problem: `${key} is not a JSON object.` };

    const bad = Object.entries(map).find(([, slug]) => !isString(slug));

    if (bad) return { problem: `${bad[0]} of ${key} names no permission slug.` };
  }

  if (!isRecord(defaultRoles)) return { problem: 'defaultRoles is not a JSON object.' };

  const badRole = Object.entries(defaultRoles).find(([, list]) => !Array.isArray(list) || !list.every(isString));

  if (badRole) return { problem: `The default role ${badRole[0]} is not a list of permission slugs.` };

  const grants = { permissions, defaultRoles, ...maps } as GrantsFile;

  if (!Object.hasOwn(value, 'personAttributes')) return { grants };

  const personAttributes = personAttributesOf(value['personAttributes']);

  if (!personAttributes) return { problem: 'personAttributes is not a map of Person attribute paths.' };

  return { grants: { ...grants, personAttributes } };
}
