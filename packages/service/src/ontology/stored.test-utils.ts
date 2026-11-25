import { readFileSync } from 'node:fs';
import type {
  OntologyIr,
  OntologyIrObjectTypeBlockDataV2,
  OntologyIrObjectTypeDatasetDatasourceV3,
  OntologyIrPropertySecurityGroup,
  OntologyIrPropertyType,
  OntologyIrSecurityGroupGranularPolicy,
  OntologyIrType,
} from '@osdk/client.unstable';
import { expect } from 'vitest';
import { orThrow } from '../errors/fallible.ts';
import { convert } from '../publish/convert.ts';
import type { OsdkSet, PublishedFunctions } from '../publish/index.ts';
import {
  CompileError,
  compileOntology,
  emptyOntology,
  parseGrantsFile,
  type CompiledObjectType,
  type CompiledOntology,
  type GrantsFile,
  type StoredOntologyVersion,
} from './index.ts';
import { committedFunctions } from '../../twin/functions/committed.ts';

export const ONTOLOGY_RID = 'ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01';

export const NS = 'com.example.twin.';

export type TwinVersion = '0.4.0' | '0.6.3' | '0.7.0';

export function twinIr(version: TwinVersion): OntologyIr {
  return JSON.parse(readFileSync(new URL(`../../twin/ir/${version}.json`, import.meta.url), 'utf8')) as OntologyIr;
}

export function twinBlock(version: TwinVersion, apiName: string): OntologyIrObjectTypeBlockDataV2 {
  const block = twinIr(version).ontology.objectTypes[apiName];

  if (!block) throw new Error(`The twin ${version} IR has no Object Type ${apiName}.`);

  return structuredClone(block);
}

export function datasetOf(block: OntologyIrObjectTypeBlockDataV2 | undefined): OntologyIrObjectTypeDatasetDatasourceV3 {
  const definition = block?.datasources[0]?.datasource;

  if (definition?.type !== 'datasetV3') throw new Error('The first datasource of the block is not a datasetV3.');

  return definition.datasetV3;
}

export function securityGroupsOf(
  block: OntologyIrObjectTypeBlockDataV2 | undefined,
): OntologyIrPropertySecurityGroup[] {
  const groups = datasetOf(block).propertySecurityGroups?.groups;

  if (!groups) throw new Error('The first datasource of the block has no property security groups.');

  return groups;
}

export function viewPolicyOf(group: OntologyIrPropertySecurityGroup): OntologyIrSecurityGroupGranularPolicy {
  if (group.security.type !== 'granular') throw new Error(`The security of the group ${group.rid} is not granular.`);

  return group.security.granular.viewPolicy;
}

export function policiesIr(): OntologyIr {
  return JSON.parse(readFileSync(new URL('../../twin/ir/policies.json', import.meta.url), 'utf8')) as OntologyIr;
}

export function propertyPoliciesIr(): OntologyIr {
  return JSON.parse(
    readFileSync(new URL('../../twin/ir/property-policies.json', import.meta.url), 'utf8'),
  ) as OntologyIr;
}

export function attributesIr(): OntologyIr {
  return JSON.parse(readFileSync(new URL('../../twin/ir/attributes.json', import.meta.url), 'utf8')) as OntologyIr;
}

export const ATTRIBUTE_DECLARATIONS = {
  jobsiteIds: { start: { objectType: `${NS}CrewMember`, property: 'userId' }, links: ['crew', 'jobsites'] },
  memberIds: { start: { objectType: `${NS}CrewMember`, property: 'userId' }, links: [] },
} as const;

export function jobsiteIr(): OntologyIr {
  return JSON.parse(readFileSync(new URL('../../twin/ir/jobsite.json', import.meta.url), 'utf8')) as OntologyIr;
}

export const JOBSITE_DECLARATIONS = { jobsiteIds: ATTRIBUTE_DECLARATIONS.jobsiteIds } as const;

function osdkSet(): OsdkSet {
  const sets = JSON.parse(readFileSync(new URL('../../osdk-sets.json', import.meta.url), 'utf8')) as {
    name: string;
    packages: OsdkSet;
  }[];

  const set = sets.find((s) => s.name === 'client-2.92.0');

  if (!set) throw new Error('osdk-sets.json has no client-2.92.0.');

  return set.packages;
}

export function stored(
  ir: OntologyIr,
  options: { version?: number; functions?: PublishedFunctions } = {},
): StoredOntologyVersion & { readonly ir: OntologyIr } {
  return {
    version: options.version ?? 1,
    ir,
    metadata: emptyOntology(ONTOLOGY_RID).metadata,
    osdkSet: osdkSet(),
    grants: null,
    ...(options.functions ? { functions: options.functions } : {}),
  };
}

export function twinGrants(version: TwinVersion): GrantsFile {
  const parsed = parseGrantsFile(
    JSON.parse(readFileSync(new URL(`../../twin/ontology/${version}/grants.json`, import.meta.url), 'utf8')),
  );

  if ('problem' in parsed) throw new Error(parsed.problem);

  return parsed.grants;
}

export function twinGrantsFile(): GrantsFile {
  return twinGrants('0.7.0');
}

export const USE = 'twin:use';

export function grantsOf(ir: unknown, roles: readonly string[] = ['admin', 'member']): GrantsFile {
  const ontology = (ir as Partial<Pick<OntologyIr, 'ontology'>>).ontology;
  const each = (names: object | undefined) => Object.fromEntries(Object.keys(names ?? {}).map((name) => [name, USE]));

  return {
    permissions: { [USE]: { description: 'Use the twin' } },
    objectTypes: each(ontology?.objectTypes),
    actionTypes: each(ontology?.actionTypes),
    defaultRoles: Object.fromEntries(roles.map((role) => [role, role === 'admin' ? ['ontology:install', USE] : [USE]])),
  };
}

export function twinObjectType(name: string): OntologyIrObjectTypeBlockDataV2 {
  const block = twinIr('0.4.0').ontology.objectTypes[`${NS}${name}`];

  if (!block) throw new Error(`The twin 0.4.0 IR has no Object Type ${name}.`);

  return structuredClone(block);
}

export function renamed(block: OntologyIrObjectTypeBlockDataV2, apiName: string): OntologyIrObjectTypeBlockDataV2 {
  block.objectType.apiName = apiName;

  return block;
}

export function stringProperty(apiName: string): OntologyIrPropertyType {
  return {
    apiName,
    displayMetadata: { displayName: apiName, visibility: 'NORMAL' },
    indexedForSearch: true,
    type: {
      type: 'string',
      string: { isLongText: false, supportsEfficientLeadingWildcard: false, supportsExactMatching: true },
    },
    typeClasses: [
      { kind: 'render_hint', name: 'SELECTABLE' },
      { kind: 'render_hint', name: 'SORTABLE' },
    ],
    status: { type: 'active', active: {} },
  };
}

export function irOf(...blocks: OntologyIrObjectTypeBlockDataV2[]): OntologyIr {
  const empty = twinIr('0.4.0');

  const records = () => ({
    objectTypes: {},
    sharedPropertyTypes: {},
    interfaceTypes: {},
    linkTypes: {},
    actionTypes: {},
  });

  return {
    ...empty,
    ontology: {
      ...records(),
      objectTypes: Object.fromEntries(blocks.map((b) => [b.objectType.apiName, b])),
      blockPermissionInformation: records(),
    },
  };
}

export function unchecked<T>(value: unknown): T {
  return value as T;
}

export function twinFunctions(version: TwinVersion): PublishedFunctions {
  return committedFunctions(version);
}

export const STRING_FLAGS = { isLongText: false, supportsEfficientLeadingWildcard: false, supportsExactMatching: true };

export function accountWith(property: OntologyIrPropertyType): OntologyIrObjectTypeBlockDataV2 {
  const account = twinObjectType('Account');

  account.objectType.propertyTypes[property.apiName] = property;

  return account;
}

export function propertyOfType(apiName: string, type: OntologyIrType): OntologyIrPropertyType {
  return { ...stringProperty(apiName), type };
}

export function compileOrThrow(version: Parameters<typeof compileOntology>[0]): CompiledOntology {
  return orThrow(compileOntology(version));
}

export function convertOrThrow(...args: Parameters<typeof convert>): CompiledOntology {
  return orThrow(convert(...args));
}

export function compiledObjectType(version: StoredOntologyVersion, apiName: string): CompiledObjectType {
  const objectType = compileOrThrow(version).objectTypes.get(apiName);

  if (!objectType) throw new Error(`compileOntology gave no Object Type ${apiName}.`);

  return objectType;
}

function refusal(version: StoredOntologyVersion): CompileError {
  try {
    compileOrThrow(version);
  } catch (error) {
    expect(error).toBeInstanceOf(CompileError);

    return error as CompileError;
  }

  throw new Error('compileOntology accepted the version.');
}

export function expectRefused(version: StoredOntologyVersion, ...fragments: (string | RegExp)[]): void {
  const { message } = refusal(version);

  for (const fragment of fragments) expect(message).toMatch(fragment);
}

export function expectFeatureRefused(version: StoredOntologyVersion, ...fragments: (string | RegExp)[]): void {
  const { message } = refusal(version);

  expect(message).not.toMatch(/^The IR field /);

  for (const fragment of fragments) expect(message).toMatch(fragment);
}
