import { generateClientSdkVersionTwoPointZero, type MinimalFs } from '@osdk/generator';
import type { OntologyIr } from '@osdk/client.unstable';
import type { ObjectTypeFullMetadata, OntologyFullMetadata } from '@osdk/foundry.ontologies';
import { describe, expect, it } from 'vitest';
import { emptyOntology } from './index.ts';
import { toFullMetadata } from '../publish/metadata.ts';
import { compileOrThrow, NS, stored, twinFunctions, twinIr, unchecked } from './stored.test-utils.ts';
import { structListOntology } from '../functions/structList.test-utils.ts';
import { convert, convertTwin, ONTOLOGY_RID, UUID, UUID_V5 } from '../metadata.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const NAME_RID = 'ri.ontology.main.property.63b5c614-1109-55d1-8a11-a16169ed87ef';

const DEPRECATED = {
  type: 'deprecated',
  deprecated: { message: 'Use the legal name.', deadline: '2027-01-01T00:00:00Z', replacedBy: 'name' },
};

function objectTypeOf(metadata: OntologyFullMetadata, apiName: string): ObjectTypeFullMetadata {
  const objectType = metadata.objectTypes[apiName];

  if (!objectType) throw new Error(`The converter gave no Object Type ${apiName}.`);

  return objectType;
}

function deprecatedIr(): OntologyIr {
  const ir = twinIr('0.4.0');
  const account = ir.ontology.objectTypes[ACCOUNT]?.objectType;
  const phase = account?.propertyTypes['phase'];
  const link = ir.ontology.linkTypes['account-to-engagements']?.linkType;
  const action = ir.ontology.actionTypes[`${NS}create-account`]?.actionType;

  if (!account || !phase || !link || !action)
    throw new Error('The twin 0.4.0 IR has no Account, phase, account-to-engagements, or create-account.');

  account.status = unchecked(DEPRECATED);

  phase.status = unchecked(DEPRECATED);

  link.status = unchecked(DEPRECATED);

  action.metadata.status = unchecked(DEPRECATED);

  return ir;
}

function ridsOf(value: unknown): string[] {
  const rids: string[] = [];

  JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'string' && item.startsWith('ri.')) rids.push(item);

    return item;
  });

  return rids;
}

describe('the whole Ontology metadata', () => {
  it('the ontology block has the Ontology RID of the deployment file, with apiName ontology, displayName Ontology, and description ""', () => {
    expect(convertTwin('0.4.0').metadata.ontology).toEqual({
      apiName: 'ontology',
      displayName: 'Ontology',
      description: '',
      rid: ONTOLOGY_RID,
    });
  });

  it('ontology/functions/functions#ontology-metadata: the metadata of the twin 0.4.0 with its Function closeAccount lists no query type', () => {
    const { compiled, metadata } = convertTwin('0.4.0');

    expect([...compiled.functions.keys()]).toEqual(['closeAccount']);
    expect(metadata.queryTypes).toEqual({});
    expect(metadata.actionTypesFullMetadata).toEqual({});
    expect(metadata.interfaceTypes).toEqual({});
    expect(metadata.sharedPropertyTypes).toEqual({});
    expect(metadata.valueTypes).toEqual({});
  });
});

describe('the statuses of the converter output', () => {
  it('ontology/object-link-types/object-types#statuses: a deprecated Property keeps its message, its deadline, and the RID of its replacement', () => {
    const { metadata } = convert(deprecatedIr(), { functions: twinFunctions('0.4.0') });

    expect(objectTypeOf(metadata, ACCOUNT).objectType.properties['phase']?.status).toEqual({
      type: 'deprecated',
      message: 'Use the legal name.',
      deadline: '2027-01-01T00:00:00Z',
      replacedBy: NAME_RID,
    });
  });

  it('ontology/object-link-types/object-types#statuses: a deprecated Property with no replacement has no replacedBy', () => {
    const ir = deprecatedIr();
    const phase = ir.ontology.objectTypes[ACCOUNT]?.objectType.propertyTypes['phase'];

    if (!phase) throw new Error('The twin 0.4.0 Account has no phase.');

    phase.status = unchecked({
      type: 'deprecated',
      deprecated: { message: 'Use the legal name.', deadline: '2027-01-01T00:00:00Z' },
    });

    const { metadata } = convert(ir, { functions: twinFunctions('0.4.0') });

    expect(objectTypeOf(metadata, ACCOUNT).objectType.properties['phase']?.status).toEqual({
      type: 'deprecated',
      message: 'Use the legal name.',
      deadline: '2027-01-01T00:00:00Z',
    });
  });

  it('ontology/object-link-types/object-types#statuses: a deprecated Object Type, Link side, and Action Type get only DEPRECATED, because their OSDK metadata shapes hold no reason', () => {
    const { metadata } = convert(deprecatedIr(), { functions: twinFunctions('0.4.0') });

    expect(objectTypeOf(metadata, ACCOUNT).objectType.status).toBe('DEPRECATED');
    expect(objectTypeOf(metadata, ACCOUNT).linkTypes.map((side) => side.status)).toEqual(['DEPRECATED']);
    expect(objectTypeOf(metadata, ENGAGEMENT).linkTypes.map((side) => side.status)).toEqual(['DEPRECATED']);
    expect(metadata.actionTypes[`${NS}create-account`]?.status).toBe('DEPRECATED');
  });

  it("ontology/object-link-types/object-types#statuses: OSDK's generator 2.92.0 writes a @deprecated tag with the reason, the deadline, and the replacement on a deprecated Property only", async () => {
    const { metadata } = convert(deprecatedIr(), { functions: twinFunctions('0.4.0') });
    const files = new Map<string, string>();

    const fs: MinimalFs = {
      mkdir: () => Promise.resolve(),
      writeFile: (path, contents) => {
        files.set(path, contents);

        return Promise.resolve();
      },
      readdir: () => Promise.resolve([]),
    };

    await generateClientSdkVersionTwoPointZero(metadata, 'metadata-test', fs, '/sdk', 'module');

    const account = [...files].find(([path]) => path.endsWith('/ontology/objects/Account.ts'))?.[1] ?? '';

    const tag =
      /\*\s+@deprecated\n\s*\* {3}- Use the legal name\.\n\s*\* {3}- deadline: 2027-01-01T00:00:00Z\n\s*\* {3}- replaced by: (\S+)\n/g;

    const tags = [...account.matchAll(tag)];

    expect(tags.length).toBeGreaterThan(0);

    for (const [, replacedBy] of tags) expect(replacedBy).toBe(NAME_RID);

    expect(account.match(/@deprecated\n/g)).toHaveLength(tags.length);

    const deprecatedOthers = [...files]
      .filter(([path, contents]) => !path.endsWith('/ontology/objects/Account.ts') && /@deprecated\n/.test(contents))
      .map(([path]) => path);

    expect(deprecatedOthers).toEqual([]);
  });
});

describe('the Ontology SDK of a struct list parameter', () => {
  it("ontology/action-types/action-types#parameters: OSDK's generator 2.92.0 writes rows as an optional ReadonlyArray of a StructType, with the fields in declaration order", async () => {
    const { ir, functions } = await structListOntology();

    const { metadata } = convert(ir, { functions });
    const files = new Map<string, string>();

    const fs: MinimalFs = {
      mkdir: () => Promise.resolve(),
      writeFile: (path, contents) => {
        files.set(path, contents);

        return Promise.resolve();
      },
      readdir: () => Promise.resolve([]),
    };

    await generateClientSdkVersionTwoPointZero(metadata, 'metadata-test', fs, '/sdk', 'module');

    const action =
      [...files].find(
        ([path, contents]) => path.includes('/ontology/actions/') && contents.includes('fn-apply-row-probes'),
      )?.[1] ?? '';

    expect(action).toContain('export interface Params {');

    expect(action).toContain(
      [
        '    readonly rows?: ReadonlyArray<',
        '      ActionParam.StructType<{',
        "        rowId: { type: 'string'; nullable: false };",
        "        label: { type: 'string'; nullable: false };",
        "        count: { type: 'integer'; nullable: false };",
        "        note: { type: 'string'; nullable: true };",
        "        op: { type: 'string'; nullable: false };",
        '      }>',
        '    > | null;',
      ].join('\n'),
    );
  });
});

describe('the RIDs of the converter output', () => {
  it('service/http-api#rids: each RID of the twin 0.4.0 metadata has the OSDK RID form for its resource', () => {
    const { metadata } = convertTwin('0.4.0');

    const forms = [
      'ri\\.ontology\\.main\\.ontology',
      'ri\\.ontology\\.main\\.object-type',
      'ri\\.ontology\\.main\\.property',
      'ri\\.ontology\\.main\\.relation',
      'ri\\.actions\\.main\\.action-type',
    ];

    const rids = ridsOf(metadata);

    expect(rids.length).toBeGreaterThan(0);

    for (const rid of rids) expect(rid).toMatch(new RegExp(`^(${forms.join('|')})\\.${UUID}$`));

    expect(metadata.ontology.rid).toMatch(/^ri\.ontology\.main\.ontology\./);

    for (const { objectType, linkTypes } of Object.values(metadata.objectTypes)) {
      expect(objectType.rid).toMatch(/^ri\.ontology\.main\.object-type\./);

      for (const property of Object.values(objectType.properties))
        expect(property.rid).toMatch(/^ri\.ontology\.main\.property\./);

      for (const side of linkTypes) expect(side.linkTypeRid).toMatch(/^ri\.ontology\.main\.relation\./);
    }

    for (const actionType of Object.values(metadata.actionTypes))
      expect(actionType.rid).toMatch(/^ri\.actions\.main\.action-type\./);
  });

  it('each RID except the Ontology RID is a UUID version 5 of its name in the namespace of the Ontology RID', () => {
    const { metadata } = convertTwin('0.4.0');
    const account = objectTypeOf(metadata, ACCOUNT);

    expect(account.objectType.rid).toBe('ri.ontology.main.object-type.0a27acfd-4041-57d9-9e98-8de722bf00fd');

    expect(account.objectType.properties['accountId']?.rid).toBe(
      'ri.ontology.main.property.41dcf235-9b59-5ffe-964e-d52caf2007a3',
    );

    expect(account.linkTypes.map((side) => side.linkTypeRid)).toEqual([
      'ri.ontology.main.relation.140ee44a-bd1d-5dc6-92ae-38bf3b24d65f',
    ]);

    expect(objectTypeOf(metadata, ENGAGEMENT).linkTypes.map((side) => side.linkTypeRid)).toEqual([
      'ri.ontology.main.relation.140ee44a-bd1d-5dc6-92ae-38bf3b24d65f',
    ]);

    expect(metadata.actionTypes[`${NS}close-account-action`]?.rid).toBe(
      'ri.actions.main.action-type.c2e94fe7-721f-5e98-b0c8-ea8acb3e93e0',
    );

    for (const rid of ridsOf(metadata).filter((r) => r !== ONTOLOGY_RID))
      expect(rid).toMatch(new RegExp(`\\.${UUID_V5}$`));
  });

  it('another Ontology RID gives other RIDs, in the namespace of its own UUID', () => {
    const ir = twinIr('0.4.0');

    const compiled = compileOrThrow({
      ...stored(ir, { functions: twinFunctions('0.4.0') }),
      metadata: emptyOntology('ri.ontology.main.ontology.7c9e6679-7425-40de-944b-e07fc1f90ae7').metadata,
    });

    expect(objectTypeOf(toFullMetadata(compiled), ACCOUNT).objectType.rid).toBe(
      'ri.ontology.main.object-type.b4b16246-f254-5c31-88f6-c2603f47425b',
    );
  });

  it('a later publish that changes the Ontology keeps the RID of each part that both versions have', () => {
    const first = convertTwin('0.4.0').metadata;
    const second = convertTwin('0.7.0').metadata;
    let shared = 0;

    for (const apiName of [ACCOUNT, ENGAGEMENT]) {
      const before = objectTypeOf(first, apiName);
      const after = objectTypeOf(second, apiName);

      expect(after.objectType.rid).toBe(before.objectType.rid);
      expect(after.linkTypes.map((side) => side.linkTypeRid)).toEqual(before.linkTypes.map((side) => side.linkTypeRid));

      for (const [name, property] of Object.entries(before.objectType.properties)) {
        expect(after.objectType.properties[name]?.rid, name).toBe(property.rid);

        shared += 1;
      }
    }

    for (const [apiName, actionType] of Object.entries(first.actionTypes)) {
      expect(second.actionTypes[apiName]?.rid, apiName).toBe(actionType.rid);

      shared += 1;
    }

    expect(shared).toBe(15);

    expect(objectTypeOf(second, ACCOUNT).objectType.rid).toBe(
      'ri.ontology.main.object-type.0a27acfd-4041-57d9-9e98-8de722bf00fd',
    );

    expect(objectTypeOf(second, ACCOUNT).linkTypes.map((side) => side.linkTypeRid)).toEqual([
      'ri.ontology.main.relation.140ee44a-bd1d-5dc6-92ae-38bf3b24d65f',
    ]);
  });
});
