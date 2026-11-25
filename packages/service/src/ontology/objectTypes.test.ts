import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OntologyIrObjectTypeBlockDataV2, OntologyIrPropertyType, OntologyIrType } from '@osdk/client.unstable';
import { describe, expect, it } from 'vitest';
import { type StoredOntologyVersion } from './index.ts';
import {
  accountWith,
  compiledObjectType,
  compileOrThrow,
  expectFeatureRefused,
  expectRefused,
  irOf,
  NS,
  propertyOfType,
  renamed,
  stored,
  STRING_FLAGS,
  stringProperty,
  twinFunctions,
  twinIr,
  twinObjectType,
  unchecked,
} from './stored.test-utils.ts';

const ACCOUNT = `${NS}Account`;

const STRING_ARRAY: OntologyIrType = {
  type: 'array',
  array: { subtype: { type: 'string', string: STRING_FLAGS }, reducers: [] },
};

const ENGAGEMENT = `${NS}Engagement`;

const otherBaseTypes: [string, OntologyIrType][] = [
  ['boolean', { type: 'boolean', boolean: {} }],
  ['integer', { type: 'integer', integer: {} }],
  ['double', { type: 'double', double: {} }],
  ['decimal', { type: 'decimal', decimal: { precision: 10, scale: 2 } }],
  ['date', { type: 'date', date: {} }],
  ['timestamp', { type: 'timestamp', timestamp: {} }],
];

describe('the twin 0.4.0 IR', () => {
  it('compiles the stored IR into the compiled Ontology of its version', () => {
    const compiled = compileOrThrow(stored(twinIr('0.4.0'), { version: 4, functions: twinFunctions('0.4.0') }));

    expect(compiled.version).toBe(4);
    expect([...compiled.objectTypes.keys()].sort()).toEqual([ACCOUNT, ENGAGEMENT]);
  });

  it('ontology/object-link-types/object-types#parts: gives the API name, primary key, title key, and Properties of each Object Type', () => {
    const compiled = compileOrThrow(stored(twinIr('0.4.0'), { functions: twinFunctions('0.4.0') }));
    const account = compiled.objectTypes.get(ACCOUNT);
    const engagement = compiled.objectTypes.get(ENGAGEMENT);

    expect(account?.apiName).toBe(ACCOUNT);
    expect(account?.primaryKey).toBe(account?.properties.get('accountId'));
    expect(account?.primaryKey.column).toBe('account_id');
    expect(account?.titleKey).toBe('name');
    expect([...(account?.properties.keys() ?? [])].sort()).toEqual(['accountId', 'name', 'phase']);
    expect(engagement?.apiName).toBe(ENGAGEMENT);
    expect(engagement?.primaryKey).toBe(engagement?.properties.get('engagementId'));
    expect(engagement?.primaryKey.column).toBe('engagement_id');
    expect(engagement?.titleKey).toBe('title');

    expect([...(engagement?.properties.keys() ?? [])].sort()).toEqual([
      'accountId',
      'amount',
      'createdAt',
      'engagementId',
      'status',
      'title',
    ]);
  });

  it('ontology/object-link-types/properties#parts: gives the base type and nullability of each base Property', () => {
    const engagement = compiledObjectType(stored(twinIr('0.4.0'), { functions: twinFunctions('0.4.0') }), ENGAGEMENT);

    const parts = Object.fromEntries(
      [...engagement.properties].map(([name, p]) => [name, { apiName: p.apiName, type: p.type, required: p.required }]),
    );

    expect(parts).toEqual({
      engagementId: { apiName: 'engagementId', type: { kind: 'string' }, required: true },
      accountId: { apiName: 'accountId', type: { kind: 'string' }, required: false },
      title: { apiName: 'title', type: { kind: 'string' }, required: true },
      amount: { apiName: 'amount', type: { kind: 'double' }, required: false },
      status: { apiName: 'status', type: { kind: 'string' }, required: false },
      createdAt: { apiName: 'createdAt', type: { kind: 'timestamp' }, required: false },
    });
  });

  it('makes the RID of each Object Type and Property from a UUID v5 in the Ontology RID namespace', () => {
    const compiled = compileOrThrow(stored(twinIr('0.4.0'), { functions: twinFunctions('0.4.0') }));

    expect(compiled.objectTypes.get(ACCOUNT)?.rid).toBe(
      'ri.ontology.main.object-type.0a27acfd-4041-57d9-9e98-8de722bf00fd',
    );

    expect(compiled.objectTypes.get(ENGAGEMENT)?.rid).toBe(
      'ri.ontology.main.object-type.5f141d5d-f905-51df-89ac-8b9c4053e49a',
    );

    expect(compiled.objectTypes.get(ACCOUNT)?.properties.get('accountId')?.rid).toBe(
      'ri.ontology.main.property.41dcf235-9b59-5ffe-964e-d52caf2007a3',
    );
  });
});

describe('the compile step', () => {
  it('service/code-layout#seams: is the cold-start check: it refuses a stored version with a Property type outside V1', () => {
    expectRefused(
      stored(irOf(accountWith(propertyOfType('location', { type: 'geohash', geohash: {} })))),
      'location',
      'geohash',
    );
  });

  const unknownShapes: [string, StoredOntologyVersion, string][] = [
    [
      'an unknown Property type',
      stored(irOf(accountWith(propertyOfType('score', unchecked<OntologyIrType>({ type: 'notAType', notAType: {} }))))),
      'notAType',
    ],
    [
      'a Property with no type',
      stored(irOf(accountWith(unchecked<OntologyIrPropertyType>({ ...stringProperty('score'), type: undefined })))),
      'score',
    ],
    [
      'primaryKeys that is not an array',
      stored(
        irOf(
          unchecked<OntologyIrObjectTypeBlockDataV2>(
            withObjectType(twinObjectType('Account'), { primaryKeys: 'accountId' }),
          ),
        ),
      ),
      'primaryKeys',
    ],
    [
      'an Object Type with no primaryKeys',
      stored(
        irOf(
          unchecked<OntologyIrObjectTypeBlockDataV2>(
            withObjectType(twinObjectType('Account'), { primaryKeys: undefined }),
          ),
        ),
      ),
      'primaryKeys',
    ],
  ];

  it.each(['constructor', 'toString', '__proto__'])(
    'service/code-layout#seams: refuses the Property type %s, which is a name of the Object prototype',
    (kind) => {
      const type = unchecked<OntologyIrType>({ type: kind });

      expectRefused(stored(irOf(accountWith(propertyOfType('score', type)))), 'score', kind);

      const array = unchecked<OntologyIrType>({ type: 'array', array: { subtype: { type: kind }, reducers: [] } });

      expectRefused(stored(irOf(accountWith(propertyOfType('scores', array)))), 'scores', kind);
    },
  );

  it('service/code-layout#seams: refuses the old nullability field, which the compiled Property cannot hold', () => {
    const property = stringProperty('code');

    property.dataConstraints = unchecked({ propertyTypeConstraints: [], nullability: 'NO_EXPLICIT_NULLS' });

    expectRefused(stored(irOf(accountWith(property))), 'code', 'nullabilityV2');
  });

  it.each(unknownShapes)(
    'service/code-layout#seams: checks each field that it reads, and refuses %s',
    (_case, version, fragment) => {
      expectRefused(version, fragment);
    },
  );

  it('service/code-layout#seams: the service takes the IR types from @osdk/client.unstable with import type only, at 1 pinned version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.dependencies?.['@osdk/client.unstable']).toBeUndefined();
    expect(pkg.devDependencies?.['@osdk/client.unstable']).toMatch(/^\d+\.\d+\.\d+$/);

    const imports = sourceFiles(new URL('../', import.meta.url)).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/^(?:import|export)\b[^;]*?from\s+'@osdk\/client\.unstable'/gms)].map(
        (m) => m[0],
      ),
    );

    expect(imports.length).toBeGreaterThan(0);

    for (const statement of imports) expect(statement).toMatch(/^import type /);
  });

  it('service/code-layout#libraries: no code outside auth imports a schema validation library, and the compile refuses a shape that it does not accept with CompileError', () => {
    const validators =
      /from '(?:zod|ajv|yup|joi|valibot|superstruct|io-ts|@sinclair\/typebox|arktype|class-validator)'/;

    const files = sourceFiles(new URL('../', import.meta.url)).filter((file) => !file.includes('/src/auth/'));

    expect(files.filter((file) => validators.test(readFileSync(file, 'utf8')))).toEqual([]);

    expectRefused(
      stored(irOf(accountWith(propertyOfType('shape', { type: 'geoshape', geoshape: {} })))),
      'shape',
      'geoshape',
    );
  });
});

describe('the test Ontologies', () => {
  it('service/testing#test-kinds: live in this repo, with the Ontology-as-code and the IR of each twin version', () => {
    for (const version of ['0.4.0', '0.6.3', '0.7.0']) {
      expect(existsSync(new URL(`../../twin/ontology/${version}/ontology.ts`, import.meta.url))).toBe(true);
      expect(existsSync(new URL(`../../twin/ir/${version}.json`, import.meta.url))).toBe(true);
    }

    expect(compileOrThrow(stored(twinIr('0.4.0'), { functions: twinFunctions('0.4.0') })).objectTypes.size).toBe(2);
  });
});

describe('Object Type parts', () => {
  const statuses: [string, unknown][] = [
    ['experimental', { type: 'experimental', experimental: {} }],
    ['active', { type: 'active', active: {} }],
    ['deprecated', { type: 'deprecated', deprecated: { message: 'Use Customer.', deadline: '2027-01-01T00:00:00Z' } }],
  ];

  it.each(statuses)(
    'ontology/object-link-types/object-types#parts: accepts a description and the status %s',
    (_name, status) => {
      const account = twinObjectType('Account');

      account.objectType.displayMetadata.description = 'A company that buys from us.';

      account.objectType.status = unchecked(status);

      expect(compiledObjectType(stored(irOf(account)), ACCOUNT).primaryKey.apiName).toBe('accountId');
    },
  );

  const missingParts: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
    ['display name', {}, { displayName: undefined }, 'display name'],
    ['plural display name', {}, { pluralDisplayName: undefined }, 'plural display name'],
    ['primary key', { primaryKeys: [] }, {}, 'primary key'],
    ['title key', { titlePropertyTypeRid: undefined }, {}, 'title key'],
    ['Property', { propertyTypes: {} }, {}, 'at least 1 Property'],
  ];

  it.each(missingParts)(
    'ontology/object-link-types/object-types#parts: refuses an Object Type with no %s',
    (_part, objectTypeChange, displayChange, fragment) => {
      const account = twinObjectType('Account');

      const changed = withObjectType(account, {
        ...objectTypeChange,
        displayMetadata: { ...account.objectType.displayMetadata, ...displayChange },
      });

      expectFeatureRefused(stored(irOf(unchecked(changed))), ACCOUNT, fragment);
    },
  );

  it('ontology/object-link-types/object-types#parts: accepts 1,500 Properties and refuses 1,501', () => {
    const withProperties = (count: number) => {
      const account = twinObjectType('Account');

      for (let i = Object.keys(account.objectType.propertyTypes).length; i < count; i++) {
        const name = `extra${i}`;

        account.objectType.propertyTypes[name] = stringProperty(name);
      }

      expect(Object.keys(account.objectType.propertyTypes)).toHaveLength(count);

      return stored(irOf(account));
    };

    expect(compiledObjectType(withProperties(1500), ACCOUNT).properties.size).toBe(1500);

    expectRefused(withProperties(1501), ACCOUNT, '1,500');
  });
});

describe('Object Type API names', () => {
  it.each([`${NS}Account2`, `${NS}WorkOrder`, `${NS}A`])(
    'ontology/object-link-types/object-types#api-names: accepts the PascalCase API name %s',
    (apiName) => {
      expect(compiledObjectType(stored(irOf(renamed(twinObjectType('Account'), apiName))), apiName).apiName).toBe(
        apiName,
      );
    },
  );

  it.each([`${NS}Work_Order`, `${NS}Work-Order`, `${NS}2Account`])(
    'ontology/object-link-types/object-types#api-names: refuses %s, which is not an uppercase letter and then only letters and digits',
    (apiName) => {
      expectRefused(
        stored(irOf(renamed(twinObjectType('Account'), apiName))),
        apiName,
        'uppercase letter',
        'only letters and digits',
      );
    },
  );

  it.each([`${NS}Work.Order`, 'com.OSDK.ontology.Account', 'com.example_x.ontology.Account'])(
    'ontology/object-link-types/object-types#api-names: refuses %s, whose API namespace does not match the maker pattern, and the error gives the rule',
    (apiName) => {
      expectRefused(stored(irOf(renamed(twinObjectType('Account'), apiName))), apiName, 'API namespace');
    },
  );

  it('ontology/object-link-types/object-types#api-names: refuses a lowercase first letter after the API namespace, and the error gives the rule', () => {
    const apiName = `${NS}account`;

    expectRefused(
      stored(irOf(renamed(twinObjectType('Account'), apiName))),
      apiName,
      'uppercase letter',
      'only letters and digits',
    );
  });

  it('ontology/object-link-types/object-types#api-names: accepts a hyphen and a digit in the API namespace', () => {
    const apiName = 'com.example.os2.Account';

    expect(compiledObjectType(stored(irOf(renamed(twinObjectType('Account'), apiName))), apiName).apiName).toBe(
      apiName,
    );
  });

  it('ontology/object-link-types/object-types#api-names: counts the full API name, and accepts 100 characters but refuses 101', () => {
    const name100 = `${NS}A${'a'.repeat(100 - NS.length - 1)}`;
    const name101 = `${name100}a`;

    expect(name100).toHaveLength(100);

    expect(compiledObjectType(stored(irOf(renamed(twinObjectType('Account'), name100))), name100).apiName).toBe(
      name100,
    );

    expectRefused(stored(irOf(renamed(twinObjectType('Account'), name101))), name101, '1 to 100 characters');
  });

  it('ontology/object-link-types/object-types#api-names: refuses 2 Object Types with the same API name', () => {
    const ir = irOf(twinObjectType('Account'));

    ir.ontology.objectTypes[`${NS}Account2`] = twinObjectType('Account');

    expectRefused(stored(ir), ACCOUNT, 'unique');
  });

  it.each(['ontology', 'object', 'property', 'link', 'relation', 'rid', 'primaryKey', 'typeId', 'ontologyObject'])(
    'ontology/object-link-types/object-types#api-names, ontology/object-link-types/properties#api-names: refuses the reserved word %s as a Property API name',
    (word) => {
      expectRefused(stored(irOf(accountWith(stringProperty(word)))), word, 'reserved');
    },
  );

  it.each(['typeID', 'primarykey', 'ONTOLOGYOBJECT'])(
    'ontology/object-link-types/object-types#api-names, ontology/object-link-types/properties#api-names: refuses the reserved word %s in another case as a Property API name',
    (word) => {
      expectRefused(stored(irOf(accountWith(stringProperty(word)))), word, 'reserved');
    },
  );

  it.each(['Object', 'Link', 'Ontology', 'PrimaryKey', 'OntologyObject'])(
    'ontology/object-link-types/object-types#api-names: refuses the reserved word %s, in any case, as the part of an Object Type API name',
    (part) => {
      const apiName = `${NS}${part}`;

      expectRefused(stored(irOf(renamed(twinObjectType('Account'), apiName))), apiName, 'reserved');
    },
  );

  it('ontology/object-link-types/object-types#api-names: accepts objects, which is not a reserved word', () => {
    expect(
      compiledObjectType(stored(irOf(accountWith(stringProperty('objects')))), ACCOUNT).properties.get('objects')
        ?.apiName,
    ).toBe('objects');
  });

  it('ontology/object-link-types/object-types#api-names: refuses a Property whose column is the hidden version column', () => {
    expectRefused(stored(irOf(accountWith(stringProperty('__version')))), '__version', 'version column');
  });

  it('ontology/object-link-types/object-types#api-names: refuses an Object Type whose table name is the hidden version column name', () => {
    const apiName = `${NS}__version`;

    expectRefused(stored(irOf(renamed(twinObjectType('Account'), apiName))), apiName, 'version column');
  });

  it('ontology/object-link-types/object-types#api-names: accepts the Property version, whose column is not the hidden version column', () => {
    const version = compiledObjectType(stored(irOf(accountWith(stringProperty('version')))), ACCOUNT).properties.get(
      'version',
    );

    expect(version?.column).toBe('version');
  });
});

describe('Property parts and API names', () => {
  it.each(otherBaseTypes)(
    'ontology/object-link-types/properties#parts: accepts a Property of base type %s',
    (kind, type) => {
      const account = compiledObjectType(stored(irOf(accountWith(propertyOfType('value', type)))), ACCOUNT);

      expect(account.properties.get('value')?.type.kind).toBe(kind);
    },
  );

  it('ontology/object-link-types/properties#parts: accepts an array Property, with the array flag in its type', () => {
    const account = compiledObjectType(stored(irOf(accountWith(propertyOfType('tags', STRING_ARRAY)))), ACCOUNT);

    expect(account.properties.get('tags')?.type).toEqual({ kind: 'array', element: { kind: 'string' } });
  });

  it.each([
    ['experimental', { type: 'experimental', experimental: {} }],
    ['deprecated', { type: 'deprecated', deprecated: { message: 'Use phase.', deadline: '2027-01-01T00:00:00Z' } }],
  ])(
    'ontology/object-link-types/properties#parts: accepts a description and the Property status %s',
    (_name, status) => {
      const property = stringProperty('stage');

      property.displayMetadata.description = 'The sales stage.';

      property.status = unchecked(status);

      expect(compiledObjectType(stored(irOf(accountWith(property))), ACCOUNT).properties.get('stage')?.apiName).toBe(
        'stage',
      );
    },
  );

  const missingPropertyParts: [string, OntologyIrPropertyType][] = [
    ['API name', unchecked({ ...stringProperty('stage'), apiName: undefined })],
    ['display name', unchecked({ ...stringProperty('stage'), displayMetadata: { visibility: 'NORMAL' } })],
    ['base type', unchecked({ ...stringProperty('stage'), type: undefined })],
  ];

  it.each(missingPropertyParts)(
    'ontology/object-link-types/properties#parts: refuses a Property with no %s',
    (_part, property) => {
      const account = twinObjectType('Account');

      account.objectType.propertyTypes['stage'] = property;

      expectRefused(stored(irOf(account)), 'stage');
    },
  );

  it.each(['startDate', 'a1', `a${'b'.repeat(99)}`])(
    'ontology/object-link-types/properties#api-names: accepts the camelCase Property API name %s',
    (name) => {
      expect(
        compiledObjectType(stored(irOf(accountWith(stringProperty(name)))), ACCOUNT).properties.get(name)?.apiName,
      ).toBe(name);
    },
  );

  it.each(['StartDate', 'start_date', 'start-date', '1start', `a${'b'.repeat(100)}`])(
    'ontology/object-link-types/properties#api-names: refuses the Property API name %s',
    (name) => {
      expectRefused(
        stored(irOf(accountWith(stringProperty(name)))),
        name,
        'lowercase letter',
        'only letters and digits',
        '1 to 100 characters',
      );
    },
  );

  it('ontology/object-link-types/properties#api-names: refuses 2 Properties with the same API name in 1 Object Type', () => {
    const account = twinObjectType('Account');

    account.objectType.propertyTypes['phase2'] = stringProperty('phase');

    expectRefused(stored(irOf(account)), 'phase', 'unique');
  });
});

describe('Object Edit History', () => {
  type EntityMetadata = OntologyIrObjectTypeBlockDataV2['entityMetadata'];

  function accountWithHistory(editsHistory: unknown): OntologyIrObjectTypeBlockDataV2 {
    const account = twinObjectType('Account');

    account.entityMetadata = unchecked<EntityMetadata>({ ...account.entityMetadata, editsHistory });

    return account;
  }

  it.each([true, false])(
    'keeps an enabled edit history with storeAllPreviousProperties: %s',
    (storeAllPreviousProperties) => {
      const account = accountWithHistory({ type: 'config', config: { store: ACCOUNT, storeAllPreviousProperties } });

      expect(compiledObjectType(stored(irOf(account)), ACCOUNT).editsHistory).toEqual({ storeAllPreviousProperties });
    },
  );

  it('keeps an enabled edit history with no storeAllPreviousProperties, as storeAllPreviousProperties: false', () => {
    const account = accountWithHistory({ type: 'config', config: { store: ACCOUNT } });

    expect(compiledObjectType(stored(irOf(account)), ACCOUNT).editsHistory).toEqual({
      storeAllPreviousProperties: false,
    });
  });

  it('gives no edit history when the IR disables it', () => {
    expect(
      compiledObjectType(stored(irOf(accountWithHistory({ type: 'none', none: {} }))), ACCOUNT),
    ).not.toHaveProperty('editsHistory');
  });

  it('gives no edit history when the IR has none', () => {
    expect(compiledObjectType(stored(irOf(twinObjectType('Account'))), ACCOUNT)).not.toHaveProperty('editsHistory');
  });

  it('service/code-layout#seams: refuses an edit history of a kind that it does not know', () => {
    expectRefused(stored(irOf(accountWithHistory({ type: 'import', import: {} }))), ACCOUNT, 'import');
  });

  it('service/code-layout#seams: refuses an edit history that another Object Type stores', () => {
    const account = accountWithHistory({ type: 'config', config: { store: ENGAGEMENT } });

    expectRefused(stored(irOf(account)), ACCOUNT, ENGAGEMENT);
  });
});

describe('Keys', () => {
  it('ontology/object-link-types/properties#keys: refuses an Integer primary key under the record key of a String Property', () => {
    const account = twinObjectType('Account');

    account.objectType.propertyTypes['accountId'] = stringProperty('phase');
    account.objectType.propertyTypes['phase'] = propertyOfType('accountId', { type: 'integer', integer: {} });

    expectRefused(stored(irOf(account)), 'accountId', 'primary key');
  });

  it('ontology/object-link-types/properties#keys: refuses an array title key under the record key of a String Property', () => {
    const account = twinObjectType('Account');

    account.objectType.propertyTypes['name'] = stringProperty('note');
    account.objectType.propertyTypes['note'] = propertyOfType('name', STRING_ARRAY);

    expectRefused(stored(irOf(account)), 'name', 'title key');
  });

  it.each(otherBaseTypes)(
    'ontology/object-link-types/properties#keys: refuses a primary key of base type %s',
    (_kind, type) => {
      const account = twinObjectType('Account');

      account.objectType.propertyTypes['accountId'] = propertyOfType('accountId', type);

      expectRefused(stored(irOf(account)), 'accountId', 'primary key');
    },
  );

  it('ontology/object-link-types/properties#keys: refuses an array title key', () => {
    const account = twinObjectType('Account');

    account.objectType.propertyTypes['name'] = propertyOfType('name', STRING_ARRAY);

    expectRefused(stored(irOf(account)), 'name', 'title key');
  });

  it('ontology/object-link-types/properties#keys: accepts an array Property that is not the title key', () => {
    const account = compiledObjectType(stored(irOf(accountWith(propertyOfType('tags', STRING_ARRAY)))), ACCOUNT);

    expect(account.titleKey).toBe('name');

    const tags = account.properties.get('tags')?.type;

    expect(tags?.kind).toBe('array');
    expect(tags?.kind === 'array' ? tags.element : undefined).toEqual({ kind: 'string' });
  });

  const struct: OntologyIrType = unchecked({
    type: 'struct',
    struct: {
      structFields: [
        {
          apiName: 'label',
          displayMetadata: { displayName: 'label' },
          typeClasses: [],
          aliases: [],
          fieldType: { type: 'string', string: STRING_FLAGS },
        },
      ],
    },
  });

  it.each([
    ['primary key', 'accountId'],
    ['title key', 'name'],
  ])('ontology/object-link-types/properties#keys: refuses a struct %s', (role, property) => {
    const account = twinObjectType('Account');

    account.objectType.propertyTypes[property] = propertyOfType(property, struct);

    expectRefused(stored(irOf(account)), property, role);
  });
});

describe('Required Properties', () => {
  it('ontology/object-link-types/properties#required-properties: a Property with no nullability is optional', () => {
    const account = compiledObjectType(stored(twinIr('0.4.0'), { functions: twinFunctions('0.4.0') }), ACCOUNT);

    expect(account.properties.get('phase')?.required).toBe(false);
    expect(account.properties.get('name')?.required).toBe(true);
  });

  it('ontology/object-link-types/properties#required-properties: refuses noEmptyCollections: true without noNulls: true', () => {
    const property = propertyOfType('tags', STRING_ARRAY);

    property.dataConstraints = {
      propertyTypeConstraints: [],
      nullabilityV2: { noNulls: false, noEmptyCollections: true },
    };

    expectRefused(stored(irOf(accountWith(property))), 'tags', 'noEmptyCollections');
  });

  it('ontology/object-link-types/properties#required-properties: accepts noEmptyCollections: true with noNulls: true', () => {
    const property = propertyOfType('tags', STRING_ARRAY);

    property.dataConstraints = {
      propertyTypeConstraints: [],
      nullabilityV2: { noNulls: true, noEmptyCollections: true },
    };

    const tags = compiledObjectType(stored(irOf(accountWith(property))), ACCOUNT).properties.get('tags');

    expect(tags?.required).toBe(true);
    expect(tags?.noEmptyCollections).toBe(true);
  });

  it('ontology/object-link-types/properties#required-properties: the primary key is required with no nullability declaration', () => {
    const ir = twinIr('0.4.0');

    expect(ir.ontology.objectTypes[ACCOUNT]?.objectType.propertyTypes['accountId']?.dataConstraints).toBeUndefined();

    expect(
      compiledObjectType(stored(ir, { functions: twinFunctions('0.4.0') }), ACCOUNT).properties.get('accountId')
        ?.required,
    ).toBe(true);
  });
});

function withObjectType(
  block: OntologyIrObjectTypeBlockDataV2,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const defined = (record: object) =>
    Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

  const objectType = defined({ ...block.objectType, ...fields });

  return { ...block, objectType: { ...objectType, displayMetadata: defined(objectType['displayMetadata'] as object) } };
}

function sourceFiles(dir: URL): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !/\.(test|test-utils|fixture)\.ts$/.test(entry.name),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}
