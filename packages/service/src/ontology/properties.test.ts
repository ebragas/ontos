import type {
  OntologyIr,
  OntologyIrObjectTypeBlockDataV2,
  OntologyIrPropertyType,
  OntologyIrType,
} from '@osdk/client.unstable';
import { describe, expect, it } from 'vitest';
import { type CompiledObjectType } from './index.ts';
import {
  accountWith,
  compiledObjectType,
  compileOrThrow,
  expectRefused,
  irOf,
  NS,
  propertyOfType,
  stored,
  STRING_FLAGS,
  stringProperty,
  twinIr,
  twinObjectType,
  type TwinVersion,
  unchecked,
} from './stored.test-utils.ts';

function expectIgnored(changed: OntologyIr, unchanged: OntologyIr): void {
  expect(withoutDisplay(compileOrThrow(stored(changed)).objectTypes)).toEqual(
    withoutDisplay(compileOrThrow(stored(unchanged)).objectTypes),
  );
}

function withoutDisplay(objectTypes: ReadonlyMap<string, CompiledObjectType>): unknown[] {
  return [...objectTypes.values()].map((type) => ({
    ...omitDisplay(type),
    primaryKey: omitDisplay(type.primaryKey),
    properties: [...type.properties.values()].map(omitDisplay),
  }));
}

function omitDisplay<T extends { readonly display: unknown }>(value: T): Omit<T, 'display'> {
  const { display, ...rest } = value;

  void display;

  return rest;
}

function structType(fields: [string, OntologyIrType][]): OntologyIrType {
  return {
    type: 'struct',
    struct: {
      structFields: fields.map(([apiName, fieldType]) => ({
        apiName,
        displayMetadata: { displayName: apiName },
        typeClasses: [],
        aliases: [],
        fieldType,
      })),
    },
  };
}

function structProperty(apiName: string, fields: [string, OntologyIrType][]): OntologyIrPropertyType {
  return { ...propertyOfType(apiName, structType(fields)), typeClasses: [] };
}

function twinBlock(version: TwinVersion, name: string): OntologyIrObjectTypeBlockDataV2 {
  const block = twinIr(version).ontology.objectTypes[`${NS}${name}`];

  if (!block) throw new Error(`The twin ${version} IR has no Object Type ${name}.`);

  return structuredClone(block);
}

function propertyOf(block: OntologyIrObjectTypeBlockDataV2, name: string): OntologyIrPropertyType {
  const property = block.objectType.propertyTypes[name];

  if (!property) throw new Error(`The block has no Property ${name}.`);

  return property;
}

const ACCOUNT = `${NS}Account`;

const STRING: OntologyIrType = { type: 'string', string: STRING_FLAGS };
const DATE: OntologyIrType = { type: 'date', date: {} };

const STRING_ARRAY: OntologyIrType = { type: 'array', array: { subtype: STRING, reducers: [] } };

const ACCOUNT_RID = 'ri.ontology.main.object-type.0a27acfd-4041-57d9-9e98-8de722bf00fd';
const ACCOUNT_ID_RID = 'ri.ontology.main.property.41dcf235-9b59-5ffe-964e-d52caf2007a3';

describe('Object Type parts outside the contract', () => {
  it('ontology/object-link-types/object-types#parts: accepts the default icon of @osdk/maker', () => {
    const account = twinObjectType('Account');

    expect(account.objectType.displayMetadata.icon).toEqual({
      type: 'blueprint',
      blueprint: { locator: 'cube', color: '#2D72D2' },
    });

    expect(compiledObjectType(stored(irOf(account)), ACCOUNT).apiName).toBe(ACCOUNT);
  });

  it('ontology/object-link-types/object-types#parts: accepts another icon, and the icon changes only the display values of the compiled Ontology', () => {
    const account = twinObjectType('Account');

    account.objectType.displayMetadata.icon = {
      type: 'blueprint',
      blueprint: { locator: 'briefcase', color: '#FF0000' },
    };

    expectIgnored(irOf(account), irOf(twinObjectType('Account')));
  });

  const displayParts: [string, (block: OntologyIrObjectTypeBlockDataV2) => void][] = [
    ['a group', (b) => (b.objectType.displayMetadata.groupDisplayName = 'Sales')],
    ['the visibility PROMINENT', (b) => (b.objectType.displayMetadata.visibility = 'PROMINENT')],
    ['the visibility HIDDEN', (b) => (b.objectType.displayMetadata.visibility = 'HIDDEN')],
    ['an alias', (b) => (b.entityMetadata = unchecked({ ...b.entityMetadata, aliases: ['Client', 'Customer'] }))],
  ];

  it.each(displayParts)(
    'ontology/object-link-types/object-types#out-of-scope: accepts and ignores %s',
    (_part, change) => {
      const account = twinObjectType('Account');

      change(account);

      expectIgnored(irOf(account), irOf(twinObjectType('Account')));
    },
  );

  it('ontology/object-link-types/object-types#out-of-scope: ignores an Object Type ID and RID in the IR, and makes its own RID', () => {
    const account = twinObjectType('Account');

    const withIds = unchecked<OntologyIrObjectTypeBlockDataV2>({
      ...account,
      objectType: {
        ...account.objectType,
        id: 'account',
        rid: 'ri.ontology.main.object-type.00000000-0000-0000-0000-000000000001',
      },
    });

    expect(compiledObjectType(stored(irOf(withIds)), ACCOUNT).rid).toBe(ACCOUNT_RID);

    expectIgnored(irOf(withIds), irOf(twinObjectType('Account')));
  });

  it('ontology/object-link-types/properties#out-of-scope: ignores a Property ID and RID in the IR, and makes its own RID', () => {
    const account = twinObjectType('Account');
    const accountId = propertyOf(account, 'accountId');

    account.objectType.propertyTypes['accountId'] = unchecked({
      ...accountId,
      id: 'account-id',
      rid: 'ri.ontology.main.property.00000000-0000-0000-0000-000000000002',
    });

    expect(compiledObjectType(stored(irOf(account)), ACCOUNT).properties.get('accountId')?.rid).toBe(ACCOUNT_ID_RID);

    expectIgnored(irOf(account), irOf(twinObjectType('Account')));
  });
});

describe('Statuses outside V1', () => {
  it('ontology/object-link-types/object-types#out-of-scope: refuses an Object Type with the example status, and names it', () => {
    const account = twinObjectType('Account');

    account.objectType.status = { type: 'example', example: {} };

    expectRefused(stored(irOf(account)), ACCOUNT, 'example');
  });

  it('ontology/object-link-types/object-types#out-of-scope: refuses a Property with the example status, and names it', () => {
    const property = stringProperty('stage');

    property.status = { type: 'example', example: {} };

    expectRefused(stored(irOf(accountWith(property))), 'stage', 'example');
  });

  it('ontology/object-link-types/object-types#out-of-scope: refuses an Object Type with the status promoted, and names it', () => {
    const account = twinObjectType('Account');

    account.objectType.status = unchecked({ type: 'promoted', promoted: {} });

    expectRefused(stored(irOf(account)), ACCOUNT, 'promoted');
  });

  it('refuses an Object Type with a status outside V1: endorsed', () => {
    const account = twinObjectType('Account');

    account.objectType.status = unchecked({ type: 'endorsed', endorsed: {} });

    expectRefused(stored(irOf(account)), ACCOUNT, 'endorsed');
  });

  it.each([
    ['experimental', { type: 'experimental', experimental: {} }],
    ['active', { type: 'active', active: {} }],
    ['deprecated', { type: 'deprecated', deprecated: { message: 'Use Customer.', deadline: '2027-01-01T00:00:00Z' } }],
  ])(
    'ontology/object-link-types/object-types#out-of-scope: accepts an Object Type and a Property with the status %s',
    (_name, status) => {
      const property = stringProperty('stage');

      property.status = unchecked(status);

      const account = accountWith(property);

      account.objectType.status = unchecked(status);

      expect(compiledObjectType(stored(irOf(account)), ACCOUNT).properties.get('stage')?.apiName).toBe('stage');
    },
  );
});

describe('Interfaces', () => {
  const NAMED = `${NS}Named`;

  it('ontology/object-link-types/object-types#out-of-scope: refuses an IR with an Interface, and names Interfaces', () => {
    const ir = irOf(twinObjectType('Account'));

    ir.ontology.interfaceTypes[NAMED] = unchecked({
      interfaceType: {
        apiName: NAMED,
        displayMetadata: {
          displayName: 'Named',
          description: '',
          icon: { type: 'blueprint', blueprint: { locator: 'tag', color: '#000000' } },
        },
        actionTypeConstraints: [],
        extendsInterfaces: [],
        extendsInterfacesMetadata: [],
        links: [],
        properties: [],
        propertiesV2: {},
        propertiesV3: {},
        status: { type: 'active', active: {} },
      },
    });

    expectRefused(stored(ir), NAMED, /interface/i);
  });

  it('ontology/object-link-types/object-types#out-of-scope: refuses an Object Type that implements an Interface, and names Interfaces', () => {
    const account = twinObjectType('Account');

    account.objectType.implementsInterfaces2 = unchecked([
      { interfaceTypeApiName: NAMED, actionTypes: {}, linksV2: {}, properties: {}, propertiesV2: {} },
    ]);

    expectRefused(stored(irOf(account)), ACCOUNT, /interface/i);
  });

  it('ontology/object-link-types/object-types#out-of-scope: refuses an Object Type whose allImplementsInterfaces names an Interface, and names Interfaces', () => {
    const account = twinObjectType('Account');

    account.objectType.allImplementsInterfaces = unchecked({
      [NAMED]: { interfaceTypeApiName: NAMED, actionTypes: {}, linksV2: {}, properties: {}, propertiesV2: {} },
    });

    expectRefused(stored(irOf(account)), ACCOUNT, /interface/i);
  });

  it('ontology/object-link-types/object-types#out-of-scope: accepts the twin IR, which has no Interface', () => {
    const ir = twinIr('0.4.0');

    expect(ir.ontology.interfaceTypes).toEqual({});
    expect(ir.ontology.objectTypes[ACCOUNT]?.objectType.implementsInterfaces2).toEqual([]);
    expect(compiledObjectType(stored(irOf(twinObjectType('Account'))), ACCOUNT).apiName).toBe(ACCOUNT);
  });
});

describe('Structs', () => {
  it('ontology/object-link-types/properties#structs: compiles the struct Properties of the twin 0.6.3, with the expected struct field types and order', () => {
    const probe = compiledObjectType(stored(irOf(twinBlock('0.6.3', 'StructProbe'))), `${NS}StructProbe`);
    const measures = probe.properties.get('measures')?.type;
    const relationship = probe.properties.get('relationship')?.type;

    expect(measures).toEqual({
      kind: 'struct',
      fields: new Map([
        ['flag', { kind: 'boolean' }],
        ['count', { kind: 'integer' }],
        ['score', { kind: 'double' }],
        ['at', { kind: 'timestamp' }],
      ]),
    });

    expect(relationship).toEqual({
      kind: 'struct',
      fields: new Map([
        ['label', { kind: 'string' }],
        ['since', { kind: 'date' }],
      ]),
    });

    expect(measures?.kind === 'struct' ? [...measures.fields.keys()] : []).toEqual(['flag', 'count', 'score', 'at']);
    expect(relationship?.kind === 'struct' ? [...relationship.fields.keys()] : []).toEqual(['label', 'since']);
  });

  it.each(['startDate', 'a1', `a${'b'.repeat(99)}`])(
    'ontology/object-link-types/properties#structs: accepts the camelCase struct field API name %s',
    (name) => {
      const contract = compiledObjectType(
        stored(irOf(accountWith(structProperty('contract', [[name, DATE]])))),
        ACCOUNT,
      ).properties.get('contract');

      expect(contract?.type.kind === 'struct' ? [...contract.type.fields.keys()] : []).toEqual([name]);
    },
  );

  it.each(['StartDate', 'start_date', 'start-date', '1start', `a${'b'.repeat(100)}`])(
    'ontology/object-link-types/properties#structs: refuses the struct field API name %s, and gives the rule',
    (name) => {
      expectRefused(
        stored(irOf(accountWith(structProperty('contract', [[name, DATE]])))),
        'contract',
        name,
        'lowercase letter',
        'only letters and digits',
        '1 to 100 characters',
      );
    },
  );

  it.each(['rid', 'primaryKey'])(
    'ontology/object-link-types/properties#structs: refuses the reserved word %s as a struct field API name',
    (name) => {
      expectRefused(
        stored(irOf(accountWith(structProperty('contract', [[name, DATE]])))),
        'contract',
        name,
        'reserved',
      );
    },
  );
});

describe('Searchable', () => {
  it('ontology/object-link-types/properties#searchable: a Property is Searchable by default, and indexedForSearch: false makes it not Searchable', () => {
    const account = compiledObjectType(stored(irOf(twinBlock('0.7.0', 'Account'))), ACCOUNT);
    const searchable = Object.fromEntries([...account.properties].map(([name, p]) => [name, p.searchable]));

    expect(searchable).toEqual({ accountId: true, name: true, phase: true, note: false, active: true });
  });

  it('ontology/object-link-types/properties#searchable: a Property with no indexedForSearch in the IR is Searchable', () => {
    const property = unchecked<OntologyIrPropertyType>({ ...stringProperty('stage'), indexedForSearch: undefined });

    expect(compiledObjectType(stored(irOf(accountWith(property))), ACCOUNT).properties.get('stage')?.searchable).toBe(
      true,
    );
  });
});

describe('Property types outside V1', () => {
  it.each([
    ['Integer', { type: 'integer', integer: {} } as OntologyIrType, /integer/i],
    ['Date', DATE, /date/i],
    ['Timestamp', { type: 'timestamp', timestamp: {} } as OntologyIrType, /timestamp/i],
    ['Boolean', { type: 'boolean', boolean: {} } as OntologyIrType, /boolean/i],
  ])(
    'ontology/object-link-types/properties#out-of-scope: refuses a primary key of type %s, and names it',
    (_name, type, fragment) => {
      const account = twinObjectType('Account');

      account.objectType.propertyTypes['accountId'] = propertyOfType('accountId', type);

      expectRefused(stored(irOf(account)), 'accountId', /primary key/i, fragment);
    },
  );

  it('ontology/object-link-types/properties#out-of-scope: accepts a String primary key', () => {
    expect(
      compiledObjectType(stored(irOf(twinObjectType('Account'))), ACCOUNT).properties.get('accountId')?.type,
    ).toEqual({ kind: 'string' });
  });

  it('ontology/object-link-types/properties#out-of-scope: refuses an array title key, and names it', () => {
    const account = twinObjectType('Account');

    account.objectType.propertyTypes['name'] = propertyOfType('name', STRING_ARRAY);

    expectRefused(stored(irOf(account)), 'name', /title key/i, /array/i);
  });

  it('ontology/object-link-types/properties#out-of-scope: refuses a Property that uses a Shared Property, and names Shared Properties', () => {
    const property: OntologyIrPropertyType = {
      ...stringProperty('email'),
      sharedPropertyTypeApiName: 'email',
      sharedPropertyTypeRid: 'email',
    };

    expectRefused(stored(irOf(accountWith(property))), 'email', /shared propert/i);
  });

  it('ontology/object-link-types/properties#out-of-scope: refuses an IR with a Shared Property, and names Shared Properties', () => {
    const ir = irOf(twinObjectType('Account'));

    ir.ontology.sharedPropertyTypes['email'] = {
      sharedPropertyType: {
        apiName: 'email',
        aliases: [],
        displayMetadata: { displayName: 'Email', visibility: 'NORMAL' },
        indexedForSearch: true,
        type: STRING,
        typeClasses: [],
      },
    };

    expectRefused(stored(ir), 'email', /shared propert/i);
  });
});

describe('Render hints and display parts of Properties', () => {
  const changes: [string, (p: OntologyIrPropertyType) => void][] = [
    ['no type classes', (p) => (p.typeClasses = [])],
    [
      'other render hints',
      (p) =>
        (p.typeClasses = [
          { kind: 'render_hint', name: 'LONG_TEXT' },
          { kind: 'render_hint', name: 'IDENTIFIER' },
        ]),
    ],
    ['a type class of another kind', (p) => (p.typeClasses = [{ kind: 'geo', name: 'latitude' }])],
    ['the visibility HIDDEN', (p) => (p.displayMetadata.visibility = 'HIDDEN')],
    ['the visibility PROMINENT', (p) => (p.displayMetadata.visibility = 'PROMINENT')],
    [
      'value formatting',
      (p) => (p.baseFormatter = unchecked({ type: 'knownFormatter', knownFormatter: { type: 'userId', userId: {} } })),
    ],
    [
      'conditional formatting',
      (p) =>
        (p.ruleSetBinding = {
          ruleSetRid: 'phase-colors',
          bindings: { value: { type: 'propertyTypeRid', propertyTypeRid: 'phase' } },
        }),
    ],
  ];

  it.each(changes)(
    'ontology/object-link-types/properties#out-of-scope: accepts and ignores %s on a Property',
    (_change, change) => {
      const account = twinObjectType('Account');

      change(propertyOf(account, 'phase'));

      expectIgnored(irOf(account), irOf(twinObjectType('Account')));
    },
  );

  it('ontology/object-link-types/properties#out-of-scope: a SEARCHABLE type class changes nothing, and indexedForSearch alone sets Searchable', () => {
    const withHint = twinObjectType('Account');

    propertyOf(withHint, 'phase').indexedForSearch = false;

    propertyOf(withHint, 'phase').typeClasses.push({ kind: 'render_hint', name: 'SEARCHABLE' });

    const withoutHint = twinObjectType('Account');

    propertyOf(withoutHint, 'phase').indexedForSearch = false;

    expectIgnored(irOf(withHint), irOf(withoutHint));

    expect(compiledObjectType(stored(irOf(withHint)), ACCOUNT).properties.get('phase')?.searchable).toBe(false);
  });
});
