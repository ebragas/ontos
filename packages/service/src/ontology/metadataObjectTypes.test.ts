import type {
  OntologyIrLinkTypeBlockDataV2,
  OntologyIrObjectTypeBlockDataV2,
  OntologyIrType,
} from '@osdk/client.unstable';
import type { LinkTypeSideV2, ObjectTypeFullMetadata } from '@osdk/foundry.ontologies';
import { describe, expect, it } from 'vitest';
import { NS, propertyOfType, renamed, stringProperty, twinIr, twinObjectType } from './stored.test-utils.ts';
import { asJson, convert, convertTwin, irWith, linkSide, manyToManyLink, UUID } from '../metadata.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;
const TECHNICIAN = `${NS}Technician`;
const CERTIFICATION = `${NS}Certification`;

function objectTypeOf(
  metadata: { objectTypes: Record<string, ObjectTypeFullMetadata> },
  apiName: string,
): ObjectTypeFullMetadata {
  const objectType = metadata.objectTypes[apiName];

  if (!objectType) throw new Error(`The converter gave no Object Type ${apiName}.`);

  return objectType;
}

function twinLinkType(): OntologyIrLinkTypeBlockDataV2 {
  const block = twinIr('0.4.0').ontology.linkTypes['account-to-engagements'];

  if (!block) throw new Error('The twin 0.4.0 IR has no Link Type account-to-engagements.');

  return structuredClone(block);
}

function technicianCertifications(): {
  objectTypes: OntologyIrObjectTypeBlockDataV2[];
  linkTypes: OntologyIrLinkTypeBlockDataV2[];
} {
  const technician = renamed(twinObjectType('Account'), TECHNICIAN);
  const certification = renamed(twinObjectType('Account'), CERTIFICATION);

  const link = manyToManyLink({
    id: 'technician-certifications',
    a: TECHNICIAN,
    aKey: 'accountId',
    aSide: linkSide('certifications', 'Certification'),
    b: CERTIFICATION,
    bKey: 'accountId',
    bSide: linkSide('technicians', 'Technician'),
  });

  return { objectTypes: [technician, certification], linkTypes: [link] };
}

describe('the Object Types of the converter output', () => {
  it('ontology/object-link-types/object-types#parts: the Object Types of the twin 0.7.0 expose their Properties, Links, and default icon', () => {
    const { metadata } = convertTwin('0.7.0');

    expect(Object.keys(metadata.objectTypes).sort()).toEqual([ACCOUNT, ENGAGEMENT, STRUCT_PROBE]);

    expect(objectTypeOf(metadata, ACCOUNT).objectType.icon).toEqual({
      type: 'blueprint',
      color: '#2D72D2',
      name: 'cube',
    });

    expect(Object.keys(objectTypeOf(metadata, ACCOUNT).objectType.properties).sort()).toEqual([
      'accountId',
      'active',
      'name',
      'note',
      'phase',
    ]);
  });

  it('ontology/object-link-types/object-types#parts: the icon is the blueprint locator and color of the IR', () => {
    const account = twinObjectType('Account');

    account.objectType.displayMetadata.icon = { type: 'blueprint', blueprint: { locator: 'person', color: '#147EB3' } };

    const { metadata } = convert(irWith({ objectTypes: [account] }));

    expect(objectTypeOf(metadata, ACCOUNT).objectType.icon).toEqual({
      type: 'blueprint',
      name: 'person',
      color: '#147EB3',
    });
  });

  it('ontology/object-link-types/properties#searchable: Object Type metadata does not expose Searchable flags', () => {
    const { metadata } = convertTwin('0.7.0');

    for (const property of Object.values(objectTypeOf(metadata, ACCOUNT).objectType.properties)) {
      expect(Object.keys(property)).not.toContain('searchable');
      expect(Object.keys(property)).not.toContain('indexedForSearch');
    }
  });

  it('ontology/object-link-types/properties#structs: the struct Object Type of the twin 0.6.3 exposes structFieldTypes with struct-field RIDs', () => {
    const { metadata } = convertTwin('0.6.3');

    expect(objectTypeOf(metadata, STRUCT_PROBE).objectType.properties['relationship']?.dataType).toEqual({
      type: 'struct',
      structFieldTypes: [
        {
          apiName: 'label',
          rid: expect.stringMatching(new RegExp(`^ri\\.ontology\\.main\\.struct-field\\.${UUID}$`)),
          dataType: { type: 'string' },
          typeClasses: [],
        },
        {
          apiName: 'since',
          rid: expect.stringMatching(new RegExp(`^ri\\.ontology\\.main\\.struct-field\\.${UUID}$`)),
          dataType: { type: 'date' },
          typeClasses: [],
        },
      ],
    });
  });

  it('ontology/object-link-types/object-types#api-names: each Object Type has its fully qualified API name, with the API namespace', () => {
    const { metadata } = convertTwin('0.4.0');

    expect(Object.keys(metadata.objectTypes)).toEqual([ACCOUNT, ENGAGEMENT]);
    expect(objectTypeOf(metadata, ACCOUNT).objectType.apiName).toBe('com.example.twin.Account');
    expect(objectTypeOf(metadata, ENGAGEMENT).linkTypes[0]?.objectTypeApiName).toBe('com.example.twin.Account');
  });
});

describe('the statuses of the converter output', () => {
  it('ontology/object-link-types/object-types#statuses: an Object Type, a Property, and a Link Type each have the status of the IR', () => {
    const account = twinObjectType('Account');

    account.objectType.status = { type: 'experimental', experimental: {} };

    const phase = account.objectType.propertyTypes['phase'];

    if (!phase) throw new Error('The twin Account has no phase.');

    phase.status = { type: 'experimental', experimental: {} };

    const link = twinLinkType();

    link.linkType.status = { type: 'experimental', experimental: {} };

    const { metadata } = convert(irWith({ objectTypes: [account, twinObjectType('Engagement')], linkTypes: [link] }));

    const accountMetadata = objectTypeOf(metadata, ACCOUNT);

    expect(accountMetadata.objectType.status).toBe('EXPERIMENTAL');
    expect(accountMetadata.objectType.properties['phase']?.status).toEqual({ type: 'experimental' });
    expect(accountMetadata.objectType.properties['name']?.status).toEqual({ type: 'active' });
    expect(objectTypeOf(metadata, ENGAGEMENT).objectType.status).toBe('ACTIVE');
    expect(accountMetadata.linkTypes.map((side) => side.status)).toEqual(['EXPERIMENTAL']);
    expect(objectTypeOf(metadata, ENGAGEMENT).linkTypes.map((side) => side.status)).toEqual(['EXPERIMENTAL']);
  });

  it('ontology/object-link-types/object-types#statuses: the IR statuses experimental, active, and deprecated become EXPERIMENTAL, ACTIVE, and DEPRECATED', () => {
    const account = twinObjectType('Account');

    account.objectType.status = {
      type: 'deprecated',
      deprecated: { message: 'Use Customer.', deadline: '2027-01-01T00:00:00Z' },
    };

    const { metadata } = convert(irWith({ objectTypes: [account] }));

    expect(objectTypeOf(metadata, ACCOUNT).objectType.status).toBe('DEPRECATED');
    expect(objectTypeOf(convertTwin('0.4.0').metadata, ACCOUNT).objectType.status).toBe('ACTIVE');
  });
});

describe('the Properties of the converter output', () => {
  it('ontology/object-link-types/properties#ontology-metadata: only a Property with noNulls that is not the primary key gets dataConstraints NOT_NULLABLE, and no Property has nullable', () => {
    const account = twinObjectType('Account');
    const accountId = account.objectType.propertyTypes['accountId'];

    if (!accountId) throw new Error('The twin Account has no accountId.');

    accountId.dataConstraints = {
      propertyTypeConstraints: [],
      nullabilityV2: { noNulls: true, noEmptyCollections: false },
    };

    const { metadata } = convert(irWith({ objectTypes: [account] }));
    const properties = objectTypeOf(metadata, ACCOUNT).objectType.properties;

    expect(properties['name']?.dataConstraints).toEqual({ nullability: 'NOT_NULLABLE' });
    expect(Object.keys(properties['accountId'] ?? {})).not.toContain('dataConstraints');
    expect(Object.keys(properties['phase'] ?? {})).not.toContain('dataConstraints');

    for (const property of Object.values(properties)) expect(Object.keys(property)).not.toContain('nullable');
  });

  it('ontology/object-link-types/properties#ontology-metadata: the type classes of each Property are the type classes of the IR', () => {
    const account = twinObjectType('Account');

    account.objectType.propertyTypes['rank'] = {
      ...propertyOfType('rank', { type: 'integer', integer: {} }),
      typeClasses: [],
    };

    account.objectType.propertyTypes['code'] = {
      ...stringProperty('code'),
      typeClasses: [{ kind: 'render_hint', name: 'SELECTABLE' }],
    };

    const properties = objectTypeOf(convert(irWith({ objectTypes: [account] })).metadata, ACCOUNT).objectType
      .properties;

    expect(properties['rank']?.typeClasses).toEqual([]);
    expect(properties['code']?.typeClasses).toEqual([{ kind: 'render_hint', name: 'SELECTABLE' }]);

    expect(properties['name']?.typeClasses).toEqual([
      { kind: 'render_hint', name: 'SELECTABLE' },
      { kind: 'render_hint', name: 'SORTABLE' },
    ]);
  });

  it('service/publish#what-the-app-publishes: the converter gives the data type of each V1 base type, a Decimal, and an array', () => {
    const account = twinObjectType('Account');

    const types: Record<string, OntologyIrType> = {
      flag: { type: 'boolean', boolean: {} },
      count: { type: 'integer', integer: {} },
      score: { type: 'double', double: {} },
      price: { type: 'decimal', decimal: { precision: 10, scale: 2 } },
      openedOn: { type: 'date', date: {} },
      seenAt: { type: 'timestamp', timestamp: {} },
      tags: { type: 'array', array: { subtype: { type: 'date', date: {} }, reducers: [] } },
    };

    for (const [apiName, type] of Object.entries(types))
      account.objectType.propertyTypes[apiName] = propertyOfType(apiName, type);

    const properties = objectTypeOf(convert(irWith({ objectTypes: [account] })).metadata, ACCOUNT).objectType
      .properties;

    expect(
      Object.fromEntries(Object.entries(properties).map(([apiName, property]) => [apiName, property.dataType])),
    ).toEqual({
      accountId: { type: 'string' },
      name: { type: 'string' },
      phase: { type: 'string' },
      flag: { type: 'boolean' },
      count: { type: 'integer' },
      score: { type: 'double' },
      price: { type: 'decimal', precision: 10, scale: 2 },
      openedOn: { type: 'date' },
      seenAt: { type: 'timestamp' },
      tags: { type: 'array', subType: { type: 'date' }, reducers: [] },
    });
  });

  it('service/publish#what-the-app-publishes: an Object Type and a Property with a description in the IR show it, and the others have no description', () => {
    const account = twinObjectType('Account');

    account.objectType.displayMetadata.description = 'A customer account.';

    const name = account.objectType.propertyTypes['name'];

    if (!name) throw new Error('The twin Account has no name.');

    name.displayMetadata.description = 'The legal name.';

    const { metadata } = convert(irWith({ objectTypes: [account, twinObjectType('Engagement')] }));

    expect(objectTypeOf(metadata, ACCOUNT).objectType.description).toBe('A customer account.');
    expect(objectTypeOf(metadata, ACCOUNT).objectType.properties['name']?.description).toBe('The legal name.');

    expect(Object.keys(objectTypeOf(metadata, ACCOUNT).objectType.properties['phase'] ?? {})).not.toContain(
      'description',
    );

    expect(Object.keys(objectTypeOf(metadata, ENGAGEMENT).objectType)).not.toContain('description');
  });
});

describe('the Link sides of the converter output', () => {
  it('ontology/object-link-types/link-types#parts: a Link Type has 2 sides, 1 on the Object Type of each side', () => {
    const { metadata } = convertTwin('0.4.0');

    expect(objectTypeOf(metadata, ACCOUNT).linkTypes.map((side) => [side.apiName, side.objectTypeApiName])).toEqual([
      ['engagements', ENGAGEMENT],
    ]);

    expect(objectTypeOf(metadata, ENGAGEMENT).linkTypes.map((side) => [side.apiName, side.objectTypeApiName])).toEqual([
      ['account', ACCOUNT],
    ]);

    const manyToMany = convert(irWith(technicianCertifications())).metadata;

    expect(
      objectTypeOf(manyToMany, TECHNICIAN).linkTypes.map((side) => [side.apiName, side.objectTypeApiName]),
    ).toEqual([['certifications', CERTIFICATION]]);

    expect(
      objectTypeOf(manyToMany, CERTIFICATION).linkTypes.map((side) => [side.apiName, side.objectTypeApiName]),
    ).toEqual([['technicians', TECHNICIAN]]);
  });

  it('ontology/object-link-types/link-types#parts: each side shows the API name and the display name of the IR, and no plural display name', () => {
    const { metadata } = convertTwin('0.4.0');

    const sides: LinkTypeSideV2[] = [
      ...objectTypeOf(metadata, ACCOUNT).linkTypes,
      ...objectTypeOf(metadata, ENGAGEMENT).linkTypes,
    ];

    expect(sides.map((side) => [side.apiName, side.displayName])).toEqual([
      ['engagements', 'Engagement'],
      ['account', 'Account'],
    ]);

    for (const side of sides) expect(Object.keys(side)).not.toContain('pluralDisplayName');
  });

  it('ontology/object-link-types/link-types#parts: each side has the cardinality and the status of its Link Type, and the ONE side of a foreign key names the foreign key Property', () => {
    const { metadata } = convertTwin('0.4.0');

    expect(asJson(objectTypeOf(metadata, ENGAGEMENT).linkTypes)).toEqual([
      {
        apiName: 'account',
        displayName: 'Account',
        status: 'ACTIVE',
        objectTypeApiName: ACCOUNT,
        cardinality: 'ONE',
        foreignKeyPropertyApiName: 'accountId',
        linkTypeRid: expect.any(String),
      },
    ]);

    expect(asJson(objectTypeOf(metadata, ACCOUNT).linkTypes)).toEqual([
      {
        apiName: 'engagements',
        displayName: 'Engagement',
        status: 'ACTIVE',
        objectTypeApiName: ENGAGEMENT,
        cardinality: 'MANY',
        linkTypeRid: expect.any(String),
      },
    ]);

    const parts = technicianCertifications();
    const link = parts.linkTypes[0];

    if (!link) throw new Error('No Link Type.');

    link.linkType.status = { type: 'experimental', experimental: {} };

    const manyToMany = convert(irWith(parts)).metadata;

    for (const objectType of [TECHNICIAN, CERTIFICATION]) {
      const [side] = objectTypeOf(manyToMany, objectType).linkTypes;

      expect(side?.cardinality).toBe('MANY');
      expect(side?.status).toBe('EXPERIMENTAL');
      expect(Object.keys(side ?? {})).not.toContain('foreignKeyPropertyApiName');
    }
  });

  it('ontology/object-link-types/link-types#parts: the Link Type API name is only in the RID of each side, and a side has no description', () => {
    const link = twinLinkType();

    link.linkType.description = 'The Engagements of each Account.';

    const { compiled, metadata } = convert(
      irWith({ objectTypes: [twinObjectType('Account'), twinObjectType('Engagement')], linkTypes: [link] }),
    );

    const rid = compiled.linkTypes.get('accountToEngagements')?.rid;

    expect(rid).toMatch(new RegExp(`^ri\\.ontology\\.main\\.relation\\.${UUID}$`));

    for (const objectType of [ACCOUNT, ENGAGEMENT]) {
      const sides = objectTypeOf(metadata, objectType).linkTypes;

      expect(sides.map((side) => side.linkTypeRid)).toEqual([rid]);
      expect(JSON.stringify(sides)).not.toContain('accountToEngagements');
      expect(JSON.stringify(sides)).not.toContain('The Engagements of each Account.');
    }
  });
});

describe('the RIDs of the Object Type metadata', () => {
  it('service/http-api#rids: the twin Account has the Object Type RID ri.ontology.main.object-type.<UUID>', () => {
    const { metadata } = convertTwin('0.4.0');

    expect(objectTypeOf(metadata, ACCOUNT).objectType.rid).toBe(
      'ri.ontology.main.object-type.0a27acfd-4041-57d9-9e98-8de722bf00fd',
    );

    expect(objectTypeOf(metadata, ENGAGEMENT).objectType.rid).toBe(
      'ri.ontology.main.object-type.5f141d5d-f905-51df-89ac-8b9c4053e49a',
    );
  });

  it('service/http-api#rids: the Properties of the twin Account have the Property RID ri.ontology.main.property.<UUID>', () => {
    const properties = objectTypeOf(convertTwin('0.4.0').metadata, ACCOUNT).objectType.properties;

    expect(properties['accountId']?.rid).toBe('ri.ontology.main.property.41dcf235-9b59-5ffe-964e-d52caf2007a3');
    expect(properties['name']?.rid).toBe('ri.ontology.main.property.63b5c614-1109-55d1-8a11-a16169ed87ef');
  });

  it('service/http-api#rids: both sides of the twin Link Type have the Link Type RID ri.ontology.main.relation.<UUID>', () => {
    const { metadata } = convertTwin('0.4.0');
    const rid = 'ri.ontology.main.relation.140ee44a-bd1d-5dc6-92ae-38bf3b24d65f';

    expect(objectTypeOf(metadata, ACCOUNT).linkTypes.map((side) => side.linkTypeRid)).toEqual([rid]);
    expect(objectTypeOf(metadata, ENGAGEMENT).linkTypes.map((side) => side.linkTypeRid)).toEqual([rid]);
  });

  it('ontology/object-link-types/object-types#out-of-scope and ontology/object-link-types/properties#out-of-scope: each RID of the metadata equals the RID of the compiled Ontology', () => {
    for (const version of ['0.4.0', '0.6.3', '0.7.0'] as const) {
      const { compiled, metadata } = convertTwin(version);

      expect(Object.keys(metadata.objectTypes)).toEqual([...compiled.objectTypes.keys()]);

      for (const [apiName, objectType] of compiled.objectTypes) {
        const full = objectTypeOf(metadata, apiName);

        expect(full.objectType.rid).toBe(objectType.rid);

        expect(
          Object.fromEntries(Object.entries(full.objectType.properties).map(([name, p]) => [name, p.rid])),
        ).toEqual(Object.fromEntries([...objectType.properties].map(([name, p]) => [name, p.rid])));

        expect(full.linkTypes.map((side) => [side.apiName, side.linkTypeRid])).toEqual(
          [...objectType.links].map(([name, link]) => [name, compiled.linkTypes.get(link.linkType)?.rid]),
        );
      }
    }
  });
});
