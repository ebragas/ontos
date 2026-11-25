import type {
  LinkTypeMetadata,
  OntologyIr,
  OntologyIrLinkTypeBlockDataV2,
  OntologyIrObjectTypeBlockDataV2,
  OntologyIrOneToManyLinkDefinition,
  OntologyIrType,
} from '@osdk/client.unstable';
import { describe, expect, it } from 'vitest';
import {
  type CompiledLink,
  type CompiledLinkType,
  type CompiledObjectType,
  type StoredOntologyVersion,
} from './index.ts';
import {
  compiledObjectType,
  compileOrThrow,
  expectRefused,
  irOf,
  NS,
  renamed,
  stored,
  STRING_FLAGS,
  stringProperty,
  twinFunctions,
  twinIr,
  twinObjectType,
} from './stored.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const CONTACT = `${NS}Contact`;
const TECHNICIAN = `${NS}Technician`;
const CERTIFICATION = `${NS}Certification`;

const TWIN_LINK_ID = 'account-to-engagements';

const TWIN_LINK = 'accountToEngagements';

function compiledLinkType(version: StoredOntologyVersion, apiName: string): CompiledLinkType {
  const linkType = compileOrThrow(version).linkTypes.get(apiName);

  if (!linkType) throw new Error(`compileOntology gave no Link Type ${apiName}.`);

  return linkType;
}

function linksOf(version: StoredOntologyVersion): Record<string, Record<string, Omit<CompiledLink, 'displayName'>>> {
  const compiled = compileOrThrow(version);

  const withoutDisplayName = ({ displayName, ...link }: CompiledLink) => {
    void displayName;

    return link;
  };

  return Object.fromEntries(
    [...compiled.objectTypes].map(([name, objectType]) => [
      name,
      Object.fromEntries([...objectType.links].map(([side, link]) => [side, withoutDisplayName(link)])),
    ]),
  );
}

function twinLinkType(): OntologyIrLinkTypeBlockDataV2 {
  const block = twinIr('0.4.0').ontology.linkTypes[TWIN_LINK_ID];

  if (!block) throw new Error(`The twin 0.4.0 IR has no Link Type ${TWIN_LINK_ID}.`);

  return structuredClone(block);
}

function oneToMany(block: OntologyIrLinkTypeBlockDataV2): OntologyIrOneToManyLinkDefinition {
  const { definition } = block.linkType;

  if (definition.type !== 'oneToMany') throw new Error(`The Link Type ${block.linkType.id} is not one-to-many.`);

  return definition.oneToMany;
}

function side(apiName: string): LinkTypeMetadata {
  return {
    apiName,
    displayMetadata: {
      displayName: apiName,
      pluralDisplayName: `${apiName}s`,
      visibility: 'NORMAL',
      groupDisplayName: '',
    },
    typeClasses: [],
  };
}

function oneToManyLink(options: {
  id: string;
  oneSide: string;
  primaryKey: string;
  oneSideLink: string;
  manySide: string;
  foreignKey: string;
  manySideLink: string;
}): OntologyIrLinkTypeBlockDataV2 {
  return {
    linkType: {
      definition: {
        type: 'oneToMany',
        oneToMany: {
          cardinalityHint: 'ONE_TO_MANY',
          manyToOneLinkMetadata: side(options.manySideLink),
          objectTypeRidManySide: options.manySide,
          objectTypeRidOneSide: options.oneSide,
          oneToManyLinkMetadata: side(options.oneSideLink),
          oneSidePrimaryKeyToManySidePropertyMapping: [
            {
              from: { apiName: options.primaryKey, object: options.oneSide },
              to: { apiName: options.foreignKey, object: options.manySide },
            },
          ],
        },
      },
      id: options.id,
      status: { type: 'active', active: {} },
      redacted: false,
    },
    datasources: [],
    entityMetadata: { arePatchesEnabled: true },
  };
}

function manyToManyLink(options: {
  id: string;
  a: string;
  aKey: string;
  aSide: string;
  b: string;
  bKey: string;
  bSide: string;
}): OntologyIrLinkTypeBlockDataV2 {
  const { id, a, aKey, aSide, b, bKey, bSide } = options;

  return {
    linkType: {
      definition: {
        type: 'manyToMany',
        manyToMany: {
          objectTypeAToBLinkMetadata: side(aSide),
          objectTypeBToALinkMetadata: side(bSide),
          objectTypeRidA: a,
          objectTypeRidB: b,
          objectTypeAPrimaryKeyPropertyMapping: [
            { from: { apiName: aKey, object: a }, to: { apiName: aKey, object: a } },
          ],
          objectTypeBPrimaryKeyPropertyMapping: [
            { from: { apiName: bKey, object: b }, to: { apiName: bKey, object: b } },
          ],
        },
      },
      id,
      status: { type: 'active', active: {} },
      redacted: false,
    },
    datasources: [
      {
        datasourceName: id,
        datasource: {
          type: 'dataset',
          dataset: {
            datasetRid: `link-${id}`,
            objectTypeAPrimaryKeyMapping: [{ property: { apiName: aKey, object: a }, column: 'acct' }],
            objectTypeBPrimaryKeyMapping: [{ property: { apiName: bKey, object: b }, column: 'eng' }],
          },
        },
        editsConfiguration: { onlyAllowPrivilegedEdits: false },
      },
    ],
    entityMetadata: { arePatchesEnabled: true },
  };
}

function accountEngagementsLink(): OntologyIrLinkTypeBlockDataV2 {
  return manyToManyLink({
    id: 'account-engagements',
    a: ACCOUNT,
    aKey: 'accountId',
    aSide: 'relatedEngagements',
    b: ENGAGEMENT,
    bKey: 'engagementId',
    bSide: 'relatedAccounts',
  });
}

function keyedOnId(name: string, primaryKey: string, apiName: string): OntologyIrObjectTypeBlockDataV2 {
  const block = renamed(twinObjectType(name), apiName);
  const others = Object.entries(block.objectType.propertyTypes).filter(([key]) => key !== primaryKey);

  block.objectType.propertyTypes = { ...Object.fromEntries(others), id: stringProperty('id') };
  block.objectType.primaryKeys = ['id'];

  return block;
}

function irWith(
  objectTypes: OntologyIrObjectTypeBlockDataV2[],
  linkTypes: OntologyIrLinkTypeBlockDataV2[],
): OntologyIr {
  const ir = irOf(...objectTypes);

  for (const block of linkTypes) ir.ontology.linkTypes[block.linkType.id] = block;

  return ir;
}

function twinWith(...linkTypes: OntologyIrLinkTypeBlockDataV2[]): StoredOntologyVersion {
  return stored(irWith([twinObjectType('Account'), twinObjectType('Engagement')], linkTypes));
}

function twinLinkWith(change: (block: OntologyIrLinkTypeBlockDataV2) => void): StoredOntologyVersion {
  const block = twinLinkType();

  change(block);

  return twinWith(block);
}

function twinLinkWithId(id: string): StoredOntologyVersion {
  return twinLinkWith((block) => {
    block.linkType.id = id;
  });
}

function engagementWithAccountId(type: OntologyIrType): OntologyIrObjectTypeBlockDataV2 {
  const engagement = twinObjectType('Engagement');

  engagement.objectType.propertyTypes['accountId'] = { ...stringProperty('accountId'), type };

  return engagement;
}

function accountHierarchy(childSide: string, parentSide: string): StoredOntologyVersion {
  const account = twinObjectType('Account');

  account.objectType.propertyTypes['parentAccountId'] = stringProperty('parentAccountId');

  const link = oneToManyLink({
    id: 'account-hierarchy',
    oneSide: ACCOUNT,
    primaryKey: 'accountId',
    oneSideLink: childSide,
    manySide: ACCOUNT,
    foreignKey: 'parentAccountId',
    manySideLink: parentSide,
  });

  return stored(irWith([account], [link]));
}

describe('the twin Link Type', () => {
  it('ontology/object-link-types/link-types#api-names: gives the Link Type API name from linkType.id in kebab case', () => {
    const compiled = compileOrThrow(stored(twinIr('0.4.0'), { functions: twinFunctions('0.4.0') }));

    expect([...compiled.linkTypes.keys()]).toEqual([TWIN_LINK]);
    expect(compiled.linkTypes.get(TWIN_LINK)?.apiName).toBe(TWIN_LINK);
  });

  it.each(['0.6.3', '0.7.0'] as const)(
    'ontology/object-link-types/link-types#api-names: gives the Link Type accountToEngagements of the twin %s',
    (version) => {
      const compiled = compileOrThrow(stored(twinIr(version), { functions: twinFunctions(version) }));

      expect([...compiled.linkTypes.keys()]).toEqual([TWIN_LINK]);
    },
  );

  it('ontology/object-link-types/link-types#api-names: gives projectToTasks from the ID project-to-tasks', () => {
    const link = twinLinkType();

    link.linkType.id = 'project-to-tasks';

    expect(compiledLinkType(twinWith(link), 'projectToTasks').apiName).toBe('projectToTasks');
  });

  it('makes the Link Type RID from a UUID v5 of relation:<linkType.id> in the Ontology RID namespace', () => {
    expect(compiledLinkType(stored(twinIr('0.4.0'), { functions: twinFunctions('0.4.0') }), TWIN_LINK).rid).toBe(
      'ri.ontology.main.relation.140ee44a-bd1d-5dc6-92ae-38bf3b24d65f',
    );
  });
});

describe('Link Type parts', () => {
  it('ontology/object-link-types/link-types#parts: compiles a Link Type that joins an Object Type to itself', () => {
    const version = accountHierarchy('childAccounts', 'parentAccount');

    expect(compiledLinkType(version, 'accountHierarchy').storage).toEqual({
      kind: 'foreignKey',
      manySide: ACCOUNT,
      property: compiledObjectType(version, ACCOUNT).properties.get('parentAccountId'),
      oneSide: ACCOUNT,
      table: 'account',
    });

    expect(linksOf(version)).toEqual({
      [ACCOUNT]: {
        childAccounts: {
          apiName: 'childAccounts',
          linkType: 'accountHierarchy',
          target: ACCOUNT,
          cardinality: 'MANY',
          via: { kind: 'foreignKeyOnTarget', column: 'parent_account_id' },
        },
        parentAccount: {
          apiName: 'parentAccount',
          linkType: 'accountHierarchy',
          target: ACCOUNT,
          cardinality: 'ONE',
          via: { kind: 'foreignKeyHere', column: 'parent_account_id' },
        },
      },
    });
  });
});

describe('Link Type API names', () => {
  it('ontology/object-link-types/link-types#api-names: accepts a Link Type API name of 100 characters', () => {
    const apiName = `a${'b'.repeat(99)}`;

    expect(compiledLinkType(twinLinkWithId(apiName), apiName).apiName).toBe(apiName);
  });

  it.each(['1account', `a${'b'.repeat(100)}`])(
    'ontology/object-link-types/link-types#api-names: refuses the Link Type API name %s',
    (apiName) => {
      expectRefused(
        twinLinkWithId(apiName),
        apiName,
        'lowercase letter',
        'only letters and digits',
        '1 to 100 characters',
      );
    },
  );

  it.each(['link', 'relation', 'ontology'])(
    'ontology/object-link-types/link-types#api-names: refuses the reserved word %s as a Link Type API name',
    (word) => {
      expectRefused(twinLinkWithId(word), word, 'reserved');
    },
  );

  it('ontology/object-link-types/link-types#api-names: refuses 2 Link Types with the same API name', () => {
    const ir = irWith([twinObjectType('Account'), twinObjectType('Engagement')], [twinLinkType()]);
    const second = twinLinkType();
    const definition = oneToMany(second);

    definition.oneToManyLinkMetadata = side('otherEngagements');
    definition.manyToOneLinkMetadata = side('otherAccount');

    ir.ontology.linkTypes[`${TWIN_LINK_ID}-2`] = second;

    expectRefused(stored(ir), /accountToEngagements|account-to-engagements/, 'unique');
  });
});

describe('Link side API names', () => {
  const engagementSideNamed = (apiName: string) =>
    twinLinkWith((block) => {
      oneToMany(block).manyToOneLinkMetadata = side(apiName);
    });

  it.each(['account2', 'a1', `a${'b'.repeat(99)}`])(
    'ontology/object-link-types/link-types#api-names: accepts the camelCase Link side API name %s',
    (apiName) => {
      expect(compiledObjectType(engagementSideNamed(apiName), ENGAGEMENT).links.get(apiName)?.apiName).toBe(apiName);
    },
  );

  it.each(['Account', 'account_ref', 'account-ref', '1account', `a${'b'.repeat(100)}`])(
    'ontology/object-link-types/link-types#api-names: refuses the Link side API name %s',
    (apiName) => {
      expectRefused(
        engagementSideNamed(apiName),
        apiName,
        'lowercase letter',
        'only letters and digits',
        '1 to 100 characters',
      );
    },
  );

  it.each(['link', 'relation', 'primaryKey'])(
    'ontology/object-link-types/link-types#api-names: refuses the reserved word %s as a Link side API name',
    (word) => {
      expectRefused(engagementSideNamed(word), word, 'reserved');
    },
  );

  it('ontology/object-link-types/link-types#api-names: refuses 2 Link Types with the same Link side API name on 1 Object Type', () => {
    const second = oneToManyLink({
      id: 'account-to-open-engagements',
      oneSide: ACCOUNT,
      primaryKey: 'accountId',
      oneSideLink: 'engagements',
      manySide: ENGAGEMENT,
      foreignKey: 'accountId',
      manySideLink: 'openAccount',
    });

    expectRefused(twinWith(twinLinkType(), second), 'engagements', 'unique');
  });

  it('ontology/object-link-types/link-types#api-names: refuses a self-link with the same API name on its 2 sides', () => {
    expectRefused(accountHierarchy('accounts', 'accounts'), 'accounts', 'unique');
  });

  it('ontology/object-link-types/link-types#api-names: accepts the same Link side API name on 2 Object Types', () => {
    const contact = renamed(twinObjectType('Engagement'), CONTACT);

    const toContacts = oneToManyLink({
      id: 'account-to-contacts',
      oneSide: ACCOUNT,
      primaryKey: 'accountId',
      oneSideLink: 'contacts',
      manySide: CONTACT,
      foreignKey: 'accountId',
      manySideLink: 'account',
    });

    const version = stored(
      irWith([twinObjectType('Account'), twinObjectType('Engagement'), contact], [twinLinkType(), toContacts]),
    );

    const links = linksOf(version);

    expect(links[ENGAGEMENT]?.['account']?.linkType).toBe(TWIN_LINK);
    expect(links[CONTACT]?.['account']?.linkType).toBe('accountToContacts');
    expect(Object.keys(links[ACCOUNT] ?? {}).sort()).toEqual(['contacts', 'engagements']);
  });

  it('ontology/object-link-types/link-types#api-names: refuses a Link side API name that is a Property API name on its Object Type', () => {
    const version = twinLinkWith((block) => {
      oneToMany(block).manyToOneLinkMetadata = side('accountId');
    });

    expectRefused(version, 'accountId', 'Property');
  });

  it('ontology/object-link-types/link-types#api-names: accepts a Link side API name that is a Property API name only on the other Object Type', () => {
    const version = twinLinkWith((block) => {
      oneToMany(block).oneToManyLinkMetadata = side('title');
    });

    expect(compiledObjectType(version, ACCOUNT).links.get('title')?.target).toBe(ENGAGEMENT);
  });
});

describe('Link Type backing kinds', () => {
  it('ontology/object-link-types/link-types#backing-kinds: stores a one-to-many Link Type in a foreign key Property on the many side', () => {
    const version = stored(twinIr('0.4.0'), { functions: twinFunctions('0.4.0') });

    expect(compiledLinkType(version, TWIN_LINK)).toMatchObject({
      apiName: TWIN_LINK,
      storage: {
        kind: 'foreignKey',
        manySide: ENGAGEMENT,
        property: { apiName: 'accountId', column: 'account_id' },
        oneSide: ACCOUNT,
        table: 'engagement',
      },
    });

    expect(linksOf(version)).toEqual({
      [ACCOUNT]: {
        engagements: {
          apiName: 'engagements',
          linkType: TWIN_LINK,
          target: ENGAGEMENT,
          cardinality: 'MANY',
          via: { kind: 'foreignKeyOnTarget', column: 'account_id' },
        },
      },
      [ENGAGEMENT]: {
        account: {
          apiName: 'account',
          linkType: TWIN_LINK,
          target: ACCOUNT,
          cardinality: 'ONE',
          via: { kind: 'foreignKeyHere', column: 'account_id' },
        },
      },
    });
  });

  it('ontology/object-link-types/link-types#backing-kinds: refuses a foreign key Property that the many side does not have', () => {
    const version = twinLinkWith((block) => {
      const [mapping] = oneToMany(block).oneSidePrimaryKeyToManySidePropertyMapping;

      if (mapping) mapping.to.apiName = 'customerId';
    });

    expectRefused(version, 'customerId');
  });

  it('ontology/object-link-types/link-types#backing-kinds: stores a many-to-many Link Type in a generated join table', () => {
    const version = twinWith(accountEngagementsLink());

    expect(compiledLinkType(version, 'accountEngagements')).toMatchObject({
      apiName: 'accountEngagements',
      storage: {
        kind: 'joinTable',
        table: 'account_engagements',
        a: { objectType: ACCOUNT, column: 'a_account_id' },
        b: { objectType: ENGAGEMENT, column: 'b_engagement_id' },
      },
    });

    expect(linksOf(version)).toEqual({
      [ACCOUNT]: {
        relatedEngagements: {
          apiName: 'relatedEngagements',
          linkType: 'accountEngagements',
          target: ENGAGEMENT,
          cardinality: 'MANY',
          via: {
            kind: 'joinTable',
            table: 'account_engagements',
            sourceColumn: 'a_account_id',
            targetColumn: 'b_engagement_id',
          },
        },
      },
      [ENGAGEMENT]: {
        relatedAccounts: {
          apiName: 'relatedAccounts',
          linkType: 'accountEngagements',
          target: ACCOUNT,
          cardinality: 'MANY',
          via: {
            kind: 'joinTable',
            table: 'account_engagements',
            sourceColumn: 'b_engagement_id',
            targetColumn: 'a_account_id',
          },
        },
      },
    });
  });

  it('ontology/object-link-types/link-types#backing-kinds: stores a many-to-many self-link in a join table with an a_ and a b_ column', () => {
    const link = manyToManyLink({
      id: 'account-partners',
      a: ACCOUNT,
      aKey: 'accountId',
      aSide: 'partners',
      b: ACCOUNT,
      bKey: 'accountId',
      bSide: 'partnerOf',
    });

    const version = stored(irWith([twinObjectType('Account')], [link]));

    expect(compiledLinkType(version, 'accountPartners').storage).toEqual({
      kind: 'joinTable',
      table: 'account_partners',
      a: { objectType: ACCOUNT, column: 'a_account_id' },
      b: { objectType: ACCOUNT, column: 'b_account_id' },
    });

    expect(linksOf(version)).toEqual({
      [ACCOUNT]: {
        partners: {
          apiName: 'partners',
          linkType: 'accountPartners',
          target: ACCOUNT,
          cardinality: 'MANY',
          via: {
            kind: 'joinTable',
            table: 'account_partners',
            sourceColumn: 'a_account_id',
            targetColumn: 'b_account_id',
          },
        },
        partnerOf: {
          apiName: 'partnerOf',
          linkType: 'accountPartners',
          target: ACCOUNT,
          cardinality: 'MANY',
          via: {
            kind: 'joinTable',
            table: 'account_partners',
            sourceColumn: 'b_account_id',
            targetColumn: 'a_account_id',
          },
        },
      },
    });
  });

  it('ontology/object-link-types/link-types#backing-kinds: names the join table columns a_id and b_id when both primary keys are id', () => {
    const technician = keyedOnId('Account', 'accountId', TECHNICIAN);
    const certification = keyedOnId('Engagement', 'engagementId', CERTIFICATION);

    const link = manyToManyLink({
      id: 'technician-certifications',
      a: TECHNICIAN,
      aKey: 'id',
      aSide: 'certifications',
      b: CERTIFICATION,
      bKey: 'id',
      bSide: 'technicians',
    });

    const version = stored(irWith([technician, certification], [link]));

    expect(compiledLinkType(version, 'technicianCertifications').storage).toEqual({
      kind: 'joinTable',
      table: 'technician_certifications',
      a: { objectType: TECHNICIAN, column: 'a_id' },
      b: { objectType: CERTIFICATION, column: 'b_id' },
    });

    const links = linksOf(version);

    expect(links[TECHNICIAN]?.['certifications']?.via).toEqual({
      kind: 'joinTable',
      table: 'technician_certifications',
      sourceColumn: 'a_id',
      targetColumn: 'b_id',
    });

    expect(links[CERTIFICATION]?.['technicians']?.via).toEqual({
      kind: 'joinTable',
      table: 'technician_certifications',
      sourceColumn: 'b_id',
      targetColumn: 'a_id',
    });
  });

  it('ontology/object-link-types/link-types#backing-kinds: accepts a String foreign key Property for a String primary key', () => {
    expect(
      compiledLinkType(stored(twinIr('0.4.0'), { functions: twinFunctions('0.4.0') }), TWIN_LINK).storage,
    ).toMatchObject({ kind: 'foreignKey', property: { apiName: 'accountId' } });
  });

  it.each([
    ['Double', { type: 'double', double: {} } as OntologyIrType],
    [
      'array of String',
      { type: 'array', array: { subtype: { type: 'string', string: STRING_FLAGS }, reducers: [] } } as OntologyIrType,
    ],
  ])(
    'ontology/object-link-types/link-types#backing-kinds: refuses a foreign key Property of type %s for a String primary key',
    (_name, type) => {
      const version = stored(irWith([twinObjectType('Account'), engagementWithAccountId(type)], [twinLinkType()]));

      expectRefused(version, 'accountId', 'base type', 'primary key');
    },
  );
});

describe('OSDK Link Type features outside V1', () => {
  it('ontology/object-link-types/link-types#out-of-scope: refuses a one-to-one Link Type, and the error names the feature', () => {
    const version = twinLinkWith((block) => {
      oneToMany(block).cardinalityHint = 'ONE_TO_ONE';
    });

    expectRefused(version, /one-to-one/i);
  });

  it('ontology/object-link-types/link-types#out-of-scope: accepts the cardinality hint ONE_TO_MANY', () => {
    expect(oneToMany(twinLinkType()).cardinalityHint).toBe('ONE_TO_MANY');

    expect(
      compileOrThrow(stored(twinIr('0.4.0'), { functions: twinFunctions('0.4.0') })).linkTypes.has(TWIN_LINK),
    ).toBe(true);
  });

  it('ontology/object-link-types/link-types#out-of-scope: refuses an object-backed Link Type, and the error names the feature', () => {
    const link: OntologyIrLinkTypeBlockDataV2 = {
      linkType: {
        definition: {
          type: 'intermediary',
          intermediary: {
            objectTypeAToBLinkMetadata: side('relatedEngagements'),
            objectTypeBToALinkMetadata: side('relatedAccounts'),
            objectTypeRidA: ACCOUNT,
            objectTypeRidB: ENGAGEMENT,
            intermediaryObjectTypeRid: CONTACT,
            aToIntermediaryLinkTypeRid: 'account-to-contacts',
            intermediaryToBLinkTypeRid: 'contact-to-engagements',
          },
        },
        id: 'account-engagements-by-contact',
        status: { type: 'active', active: {} },
        redacted: false,
      },
      datasources: [],
      entityMetadata: { arePatchesEnabled: true },
    };

    const contact = renamed(twinObjectType('Engagement'), CONTACT);
    const version = stored(irWith([twinObjectType('Account'), twinObjectType('Engagement'), contact], [link]));

    expectRefused(version, /object-backed/i);
  });

  it('ontology/object-link-types/link-types#out-of-scope: accepts a many-to-many Link Type', () => {
    expect(compiledLinkType(twinWith(accountEngagementsLink()), 'accountEngagements').storage.kind).toBe('joinTable');
  });

  const sides = {
    Account: (block: OntologyIrLinkTypeBlockDataV2) => oneToMany(block).oneToManyLinkMetadata,
    Engagement: (block: OntologyIrLinkTypeBlockDataV2) => oneToMany(block).manyToOneLinkMetadata,
  };

  const visibilityCases = (['Account', 'Engagement'] as const).flatMap((on) =>
    (['HIDDEN', 'PROMINENT'] as const).map((v) => [v, on] as const),
  );

  it.each(visibilityCases)(
    'ontology/object-link-types/link-types#out-of-scope: refuses the Link side visibility %s on %s, and the error names the feature',
    (visibility, on) => {
      const version = twinLinkWith((block) => {
        sides[on](block).displayMetadata.visibility = visibility;
      });

      expectRefused(version, /visibility/i);
    },
  );

  it.each(['Account', 'Engagement'] as const)(
    'ontology/object-link-types/link-types#out-of-scope: refuses a type class on the Link side on %s, and the error names the feature',
    (on) => {
      const version = twinLinkWith((block) => {
        sides[on](block).typeClasses = [{ kind: 'schema', name: 'link' }];
      });

      expectRefused(version, /type class/i);
    },
  );

  it('ontology/object-link-types/link-types#out-of-scope: accepts the visibility NORMAL and no type classes', () => {
    const definition = oneToMany(twinLinkType());

    expect(definition.oneToManyLinkMetadata.displayMetadata.visibility).toBe('NORMAL');
    expect(definition.manyToOneLinkMetadata.typeClasses).toEqual([]);

    expect(
      compileOrThrow(stored(twinIr('0.4.0'), { functions: twinFunctions('0.4.0') })).linkTypes.has(TWIN_LINK),
    ).toBe(true);
  });

  it.each([
    ['accountToEngagements', /kebab case/i],
    ['account-To-engagements', /kebab case/i],
    ['account--engagements', /kebab case/i],
    ['account-to-engagements-', /kebab case/i],
    ['ri.ontology.main.relation.37034c87-7a95-41dc-98ff-2a71bdca189c', /RID|kebab case/i],
  ] as const)(
    'ontology/object-link-types/link-types#out-of-scope: refuses the Link Type ID %s, which differs from the kebab case API name',
    (id, feature) => {
      expectRefused(twinLinkWithId(id), id, feature);
    },
  );

  it('ontology/object-link-types/link-types#out-of-scope: accepts the Link Type ID account-to-engagements', () => {
    expect(compiledLinkType(stored(twinIr('0.4.0'), { functions: twinFunctions('0.4.0') }), TWIN_LINK).apiName).toBe(
      TWIN_LINK,
    );
  });
});

describe('the join tables of each Object Type', () => {
  function joinTablesOf(version: StoredOntologyVersion): Record<string, CompiledObjectType['joinTables']> {
    return Object.fromEntries([...compileOrThrow(version).objectTypes].map(([name, type]) => [name, type.joinTables]));
  }

  it('a many-to-many Link Type puts its join table on both Object Types, each with its own column', () => {
    expect(joinTablesOf(twinWith(accountEngagementsLink()))).toEqual({
      [ACCOUNT]: [{ table: 'account_engagements', columns: ['a_account_id'] }],
      [ENGAGEMENT]: [{ table: 'account_engagements', columns: ['b_engagement_id'] }],
    });
  });

  it('a self-link puts 1 join table with its 2 columns on the Object Type, and a one-to-many Link Type puts none', () => {
    const link = manyToManyLink({
      id: 'account-partners',
      a: ACCOUNT,
      aKey: 'accountId',
      aSide: 'partners',
      b: ACCOUNT,
      bKey: 'accountId',
      bSide: 'partnerOf',
    });

    expect(joinTablesOf(twinWith(link))).toEqual({
      [ACCOUNT]: [{ table: 'account_partners', columns: ['a_account_id', 'b_account_id'] }],
      [ENGAGEMENT]: [],
    });
  });
});
