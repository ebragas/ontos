import { readFileSync } from 'node:fs';
import type { OntologyIr, OntologyIrObjectTypeBlockDataV2 } from '@osdk/client.unstable';
import { describe, expect, it } from 'vitest';
import { CompileError } from './index.ts';
import { compileOrThrow, NS, policiesIr, propertyPoliciesIr, stored, twinIr, unchecked } from './stored.test-utils.ts';

type Json = Record<string, unknown>;

function derivedIr(): OntologyIr {
  return JSON.parse(readFileSync(new URL('../../twin/ir/derived.json', import.meta.url), 'utf8')) as OntologyIr;
}

function blockOf(ir: OntologyIr, name: string): OntologyIrObjectTypeBlockDataV2 {
  const block = ir.ontology.objectTypes[`${NS}${name}`];

  if (!block) throw new Error(`The derived IR has no Object Type ${name}.`);

  return block;
}

function datasourceOf(ir: OntologyIr, name: string, property: string): { definition: Json } {
  for (const { datasource } of blockOf(ir, name).datasources) {
    const derived = unchecked<Json>(datasource).derived as { definition: Json & { type: string } } | undefined;

    if (!derived) continue;

    const body = derived.definition[derived.definition.type] as Json;

    if (property in (body['propertyTypeMapping'] as Json)) return derived;
  }

  throw new Error(`Object Type ${name} has no derived datasource that maps ${property}.`);
}

const derivedOf = (ir: OntologyIr, name: string, property: string): Json => datasourceOf(ir, name, property).definition;

function datasetOf(ir: OntologyIr, name: string): Json {
  const found = blockOf(ir, name).datasources.find(({ datasource }) => datasource.type.startsWith('dataset'));

  if (!found) throw new Error(`Object Type ${name} has no dataset datasource.`);

  return unchecked<Json>(found.datasource)[found.datasource.type] as Json;
}

const step = (linkType: string, side: 'SOURCE' | 'TARGET') => ({
  type: 'searchAround',
  searchAround: { linkTypeIdentifier: { type: 'linkType', linkType }, linkTypeSide: side },
});

const setSteps = (definition: Json, steps: unknown[]) => {
  const body = definition[definition['type'] as string] as Json;

  body['linkDefinition'] = { type: 'multiHopLink', multiHopLink: { steps } };
};

const setMapping = (definition: Json, kind: 'linkedProperties' | 'aggregatedProperties', mapping: Json) => {
  const body = definition[definition['type'] as string] as Json;

  definition['type'] = kind;

  delete definition['linkedProperties'];

  delete definition['aggregatedProperties'];

  definition[kind] = { linkDefinition: body['linkDefinition'], propertyTypeMapping: mapping };
};

const propertyIr = (ir: OntologyIr, name: string, property: string): Json =>
  unchecked<Json>(blockOf(ir, name).objectType.propertyTypes[property]);

function refused(change: (ir: OntologyIr) => void): string {
  const ir = derivedIr();

  change(ir);

  try {
    compileOrThrow(stored(ir));
  } catch (error) {
    expect(error).toBeInstanceOf(CompileError);

    return (error as CompileError).message;
  }

  throw new Error('compileOntology accepted the IR.');
}

const ACCOUNT = `${NS}Account`;
const TRANSACTION = `${NS}Transaction`;
const ENGAGEMENT = `${NS}Engagement`;
const INVOICE = `${NS}Invoice`;

describe('ontology/object-link-types/derived-properties#publish', () => {
  it('ontology/object-link-types/derived-properties#publish: publish accepts Balance, the 2 counts, Invoice Account, and the 2 entities of a Transaction, outside the Properties', () => {
    const { objectTypes } = compileOrThrow(stored(derivedIr()));

    const derived = (name: string) => {
      const objectType = objectTypes.get(`${NS}${name}`);

      if (!objectType) throw new Error(`No Object Type ${name}.`);

      for (const apiName of objectType.derived.keys()) expect(objectType.properties.has(apiName)).toBe(false);

      return Object.fromEntries(
        [...objectType.derived].map(([apiName, property]) => [
          apiName,
          { definition: property.definition, type: property.type, hops: property.node.path.hops },
        ]),
      );
    };

    const methodInput = { type: 'methodInput' } as const;
    const around = (link: string, objectSet: object = methodInput) => ({ type: 'searchAround', objectSet, link });

    expect(derived('Account')).toEqual({
      balance: {
        definition: {
          type: 'selection',
          objectSet: around('transactions'),
          operation: { type: 'sum', selectedPropertyApiName: 'amount' },
        },
        type: { kind: 'decimal', precision: 14, scale: 2 },
        hops: 1,
      },
    });

    expect(derived('Role')).toEqual({
      assignmentCount: {
        definition: { type: 'selection', objectSet: around('assignments'), operation: { type: 'count' } },
        type: { kind: 'integer' },
        hops: 1,
      },
    });

    expect(derived('Engagement')).toEqual({
      invoiceCount: {
        definition: { type: 'selection', objectSet: around('invoices'), operation: { type: 'count' } },
        type: { kind: 'integer' },
        hops: 1,
      },
    });

    expect(derived('Invoice')).toEqual({
      invoiceAccount: {
        definition: {
          type: 'selection',
          objectSet: around('account', around('engagement')),
          operation: { type: 'get', selectedPropertyApiName: 'name' },
        },
        type: { kind: 'string' },
        hops: 2,
      },
    });

    expect(derived('Transaction')).toEqual({
      categoryEntity: {
        definition: {
          type: 'selection',
          objectSet: around('category'),
          operation: { type: 'get', selectedPropertyApiName: 'entity' },
        },
        type: { kind: 'string' },
        hops: 1,
      },
      accountEntity: {
        definition: {
          type: 'selection',
          objectSet: around('account'),
          operation: { type: 'get', selectedPropertyApiName: 'entity' },
        },
        type: { kind: 'string' },
        hops: 1,
      },
    });

    expect(derived('Category')).toEqual({});
  });

  it('ontology/object-link-types/derived-properties#publish: a derived Property keeps the rid, the status, and the display of its IR Property', () => {
    const account = compileOrThrow(stored(derivedIr())).objectTypes.get(ACCOUNT);
    const balance = account?.derived.get('balance');

    expect(balance?.rid).toMatch(/^ri\.ontology\.main\.property\./);
    expect(balance?.status).toEqual({ type: 'active' });
    expect(balance?.display.displayName).toBe('Balance');
  });

  describe('ontology/object-link-types/derived-properties#publish: each definition error', () => {
    const cases: [string, (ir: OntologyIr) => void, string][] = [
      [
        'no hop',
        (ir) => setSteps(derivedOf(ir, 'Account', 'balance'), []),
        `The derived Properties balance of Object Type ${ACCOUNT} have no hop. A derived definition has at least 1 hop.`,
      ],
      [
        'a 4th hop',
        (ir) =>
          setSteps(derivedOf(ir, 'Invoice', 'invoiceAccount'), [
            step('engagement-invoices', 'TARGET'),
            step('account-engagements', 'TARGET'),
            step('account-transactions', 'SOURCE'),
            step('category-transactions', 'TARGET'),
          ]),
        `The derived Property invoiceAccount of Object Type ${INVOICE} has a definition that publish refuses. This form has at most 3 hops.`,
      ],
      [
        'a Link Type that does not connect',
        (ir) => setSteps(derivedOf(ir, 'Account', 'balance'), [step('role-assignments', 'SOURCE')]),
        `The derived Properties balance of Object Type ${ACCOUNT} have a hop that does not connect. Link Type roleAssignments does not connect to Object Type ${ACCOUNT} on the side SOURCE. The SOURCE side is Object Type ${NS}Role.`,
      ],
      [
        'a Link Type that does not exist',
        (ir) => setSteps(derivedOf(ir, 'Account', 'balance'), [step('nope', 'SOURCE')]),
        `The derived Properties balance of Object Type ${ACCOUNT} have a hop that does not connect. The Ontology has no Link Type nope.`,
      ],
      [
        'a side that does not connect',
        (ir) => setSteps(derivedOf(ir, 'Account', 'balance'), [step('account-transactions', 'TARGET')]),
        `The derived Properties balance of Object Type ${ACCOUNT} have a hop that does not connect. Link Type accountTransactions does not connect to Object Type ${ACCOUNT} on the side TARGET. The TARGET side is Object Type ${TRANSACTION}.`,
      ],
      [
        'a deleted definition',
        (ir) =>
          (datasourceOf(ir, 'Account', 'balance').definition = {
            type: 'deleted',
            deleted: { propertyTypes: ['balance'] },
          }),
        `The derived Properties balance of Object Type ${ACCOUNT} have a deleted definition. A derived definition names Link Types that exist.`,
      ],
      [
        'a get after a MANY hop',
        (ir) =>
          setMapping(derivedOf(ir, 'Account', 'balance'), 'linkedProperties', {
            balance: { type: 'propertyType', propertyType: 'amount' },
          }),
        `The derived Property balance of Object Type ${ACCOUNT} has a definition that publish refuses. A get needs each hop to reach at most 1 Object.`,
      ],
      [
        'a selected Property that is missing',
        (ir) =>
          setMapping(derivedOf(ir, 'Account', 'balance'), 'aggregatedProperties', {
            balance: { type: 'sum', sum: { type: 'propertyType', propertyType: 'nope' } },
          }),
        `The derived Property balance of Object Type ${ACCOUNT} selects the Property nope of Object Type ${TRANSACTION}, which it does not have.`,
      ],
      [
        'a selected Property that is derived',
        (ir) =>
          setMapping(derivedOf(ir, 'Invoice', 'invoiceAccount'), 'linkedProperties', {
            invoiceAccount: { type: 'propertyType', propertyType: 'balance' },
          }),
        `The derived Property invoiceAccount of Object Type ${INVOICE} selects the derived Property balance of Object Type ${ACCOUNT}. A derived Property selects only a stored Property.`,
      ],
      ...[0, 101].map((limit): [string, (ir: OntologyIr) => void, string] => [
        `a collect limit of ${limit}`,
        (ir) =>
          setMapping(derivedOf(ir, 'Account', 'balance'), 'aggregatedProperties', {
            balance: {
              type: 'collectList',
              collectList: { linkedProperty: { type: 'propertyType', propertyType: 'amount' }, limit },
            },
          }),
        `The derived Property balance of Object Type ${ACCOUNT} has the collect limit ${limit}. A collect limit is from 1 to 100.`,
      ]),
      [
        'an operation that does not take the type',
        (ir) =>
          setMapping(derivedOf(ir, 'Account', 'balance'), 'aggregatedProperties', {
            balance: { type: 'sum', sum: { type: 'propertyType', propertyType: 'transactionId' } },
          }),
        `The derived Property balance of Object Type ${ACCOUNT} has a definition that publish refuses. The operation does not take the type of the Property.`,
      ],
      [
        'a declared type of another kind',
        (ir) => (propertyIr(ir, 'Engagement', 'invoiceCount')['type'] = { type: 'double', double: {} }),
        `The derived Property invoiceCount of Object Type ${ENGAGEMENT} declares the type double, but its definition gives integer. A derived Property declares the type of its definition.`,
      ],
      [
        'a declared Decimal of another scale',
        (ir) =>
          (propertyIr(ir, 'Account', 'balance')['type'] = { type: 'decimal', decimal: { precision: 14, scale: 3 } }),
        `The derived Property balance of Object Type ${ACCOUNT} declares the type decimal with scale 3, but its definition gives decimal with scale 2. A derived Property declares the type of its definition.`,
      ],
      [
        'a declared struct whose Decimal field has another scale',
        (ir) => {
          const line = (scale: number) => ({
            type: 'struct',
            struct: {
              structFields: [
                {
                  apiName: 'unitPrice',
                  displayMetadata: { displayName: 'unitPrice' },
                  typeClasses: [],
                  aliases: [],
                  fieldType: { type: 'decimal', decimal: { precision: 12, scale } },
                },
              ],
            },
          });

          blockOf(ir, 'Account').objectType.propertyTypes['line'] = unchecked({
            ...propertyIr(ir, 'Account', 'name'),
            apiName: 'line',
            type: line(4),
          });

          (datasetOf(ir, 'Account')['propertyMapping'] as Json)['line'] = { type: 'column', column: 'line' };

          propertyIr(ir, 'Invoice', 'invoiceAccount')['type'] = line(2);

          setMapping(derivedOf(ir, 'Invoice', 'invoiceAccount'), 'linkedProperties', {
            invoiceAccount: { type: 'propertyType', propertyType: 'line' },
          });
        },
        `The derived Property invoiceAccount of Object Type ${INVOICE} declares the type struct of unitPrice decimal with scale 2, but its definition gives struct of unitPrice decimal with scale 4. A derived Property declares the type of its definition.`,
      ],
    ];

    it.each(cases)('ontology/object-link-types/derived-properties#publish: refuses %s', (_name, change, message) => {
      expect(refused(change)).toBe(message);
    });

    it('ontology/object-link-types/derived-properties#publish: takes a declared Decimal of another precision', () => {
      const ir = derivedIr();

      propertyIr(ir, 'Account', 'balance')['type'] = { type: 'decimal', decimal: { precision: 20, scale: 2 } };

      expect(compileOrThrow(stored(ir)).objectTypes.get(ACCOUNT)?.derived.get('balance')?.type).toEqual({
        kind: 'decimal',
        precision: 20,
        scale: 2,
      });
    });
  });

  describe('ontology/object-link-types/derived-properties#publish: each wrong use', () => {
    const categoryEntity = (ir: OntologyIr) => propertyIr(ir, 'Transaction', 'categoryEntity');

    const cases: [string, (ir: OntologyIr) => void, string][] = [
      [
        'a mapped name that the Object Type does not declare',
        (ir) => {
          const definition = derivedOf(ir, 'Account', 'balance');

          ((definition['aggregatedProperties'] as Json)['propertyTypeMapping'] as Json)['ghost'] = {
            type: 'count',
            count: {},
          };
        },
        `Object Type ${ACCOUNT} maps the derived Property ghost, which it does not declare. Declare each derived Property in the Properties of its Object Type.`,
      ],
      [
        'a name that 2 datasources map',
        (ir) => {
          const definition = derivedOf(ir, 'Transaction', 'accountEntity');

          ((definition['linkedProperties'] as Json)['propertyTypeMapping'] as Json)['categoryEntity'] = {
            type: 'propertyType',
            propertyType: 'entity',
          };
        },
        `Object Type ${TRANSACTION} maps the derived Property categoryEntity in 2 derived datasources. A derived Property has 1 definition.`,
      ],
      [
        'the primary key',
        (ir) => (blockOf(ir, 'Transaction').objectType.primaryKeys = ['categoryEntity']),
        `The derived Property categoryEntity of Object Type ${TRANSACTION} is its primary key. The primary key is a stored Property.`,
      ],
      [
        'the title key',
        (ir) => (blockOf(ir, 'Transaction').objectType.titlePropertyTypeRid = 'categoryEntity'),
        `The derived Property categoryEntity of Object Type ${TRANSACTION} is its title key. The title key is a stored Property.`,
      ],
      [
        'required',
        (ir) =>
          (categoryEntity(ir)['dataConstraints'] = { nullabilityV2: { noNulls: true, noEmptyCollections: false } }),
        `The derived Property categoryEntity of Object Type ${TRANSACTION} is required. A derived Property is never required.`,
      ],
      [
        'a Uniqueness type class',
        (ir) => (categoryEntity(ir)['typeClasses'] = [{ kind: 'unique', name: 'entity' }]),
        `The derived Property categoryEntity of Object Type ${TRANSACTION} has the Uniqueness type class entity. A derived Property is in no Uniqueness constraint.`,
      ],
      [
        'a Link Type foreign key',
        (ir) => {
          const definition = unchecked<{
            linkType: { definition: { oneToMany: { oneSidePrimaryKeyToManySidePropertyMapping: [{ to: Json }] } } };
          }>(ir.ontology.linkTypes['account-transactions']);

          definition.linkType.definition.oneToMany.oneSidePrimaryKeyToManySidePropertyMapping[0].to['apiName'] =
            'accountEntity';
        },
        `The derived Property accountEntity of Object Type ${TRANSACTION} cannot be the foreign key of Link Type accountTransactions. A derived Property is computed at read time.`,
      ],
      [
        'a write by an Action rule',
        (ir) => {
          const action = structuredClone(twinIr('0.6.3').ontology.actionTypes[`${NS}set-account-phase`]);

          const text = JSON.stringify(action)
            .replace('"propertyValues":{"phase"', '"propertyValues":{"balance"')
            .replace('"propertyTypeId":"phase"', '"propertyTypeId":"name"');

          ir.ontology.actionTypes[`${NS}set-account-phase`] = JSON.parse(text);
        },
        `The derived Property balance of Object Type ${ACCOUNT} cannot be written by Action Type ${NS}set-account-phase. A derived Property is computed at read time.`,
      ],
      [
        'a name in a property security policy',
        (ir) => {
          const groups = unchecked<{ groups: Json[] }>(
            datasetOf(propertyPoliciesIr(), 'Account')['propertySecurityGroups'],
          ).groups;

          const plain = groups.find((group) => group['rid'] === 'plain');

          datasetOf(ir, 'Transaction')['propertySecurityGroups'] = {
            groups: [{ ...plain, properties: ['categoryEntity'] }],
          };
        },
        `The derived Property categoryEntity of Object Type ${TRANSACTION} cannot be in the property security policy 'plain'. A derived Property is computed at read time.`,
      ],
      [
        'a name in an object security policy',
        (ir) => {
          const [own] = unchecked<{ groups: Json[] }>(
            datasetOf(policiesIr(), 'Account')['propertySecurityGroups'],
          ).groups;

          const text = JSON.stringify(own).replaceAll('"ownerId"', '"categoryEntity"');

          const group = JSON.parse(text) as {
            security: { granular: { viewPolicy: { granularPolicyCondition: { or: { conditions: Json[] } } } } };
          };

          const { conditions } = group.security.granular.viewPolicy.granularPolicyCondition.or;

          group.security.granular.viewPolicy.granularPolicyCondition.or.conditions = conditions.filter((condition) =>
            JSON.stringify(condition).includes('categoryEntity'),
          );

          datasetOf(ir, 'Transaction')['propertySecurityGroups'] = {
            groups: [{ ...group, properties: ['transactionId'] }],
          };
        },
        `The derived Property categoryEntity of Object Type ${TRANSACTION} cannot be read by a security policy. A derived Property is computed at read time.`,
      ],
    ];

    it.each(cases)('ontology/object-link-types/derived-properties#publish: refuses %s', (_name, change, message) => {
      expect(refused(change)).toBe(message);
    });

    it('ontology/object-link-types/derived-properties#publish: refuses a value type that the IR defines, and names the Object Type, the Property, and the value type', () => {
      const message = refused((ir) => {
        const metadata = {
          apiName: 'entityCode',
          packageNamespace: 'com.acme',
          displayMetadata: { displayName: 'entityCode', description: '' },
        };

        const baseType = { type: 'string', string: {} };

        ir.valueTypes = unchecked({
          valueTypes: [
            {
              metadata: { ...metadata, status: { type: 'active', active: {} } },
              versions: [{ version: '1.0.0', baseType, constraints: [], exampleValues: [] }],
            },
          ],
        });

        propertyIr(ir, 'Transaction', 'categoryEntity')['valueType'] = { ...metadata, version: '1.0.0' };
      });

      expect(message).toBe(
        `The derived Property categoryEntity of Object Type ${TRANSACTION} has the value type entityCode. A derived Property has no value type.`,
      );
    });
  });
});
