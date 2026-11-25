import { readFileSync } from 'node:fs';
import type { OntologyIr } from '@osdk/client.unstable';
import { describe, expect, it } from 'vitest';
import { CompileError, type CompiledObjectType } from './index.ts';
import { compileOrThrow, NS, stored, unchecked } from './stored.test-utils.ts';

type Json = Record<string, unknown>;

type TypeClass = { kind: string; name: string };

const INVOICE = `${NS}Invoice`;
const MEMBERSHIP = `${NS}Membership`;

function makerIr(): OntologyIr {
  return JSON.parse(readFileSync(new URL('../../twin/ir/uniqueness.json', import.meta.url), 'utf8')) as OntologyIr;
}

function propertyOf(ir: OntologyIr, objectType: string, property: string): Json {
  const found = unchecked<Record<string, Json> | undefined>(
    ir.ontology.objectTypes[objectType]?.objectType.propertyTypes,
  )?.[property];

  if (!found) throw new Error(`The IR has no Property ${property} on ${objectType}.`);

  return found;
}

function withTypeClasses(objectType: string, property: string, typeClasses: TypeClass[], ir = makerIr()): OntologyIr {
  propertyOf(ir, objectType, property)['typeClasses'] = typeClasses;

  return ir;
}

const unique = (name: string): TypeClass => ({ kind: 'unique', name });

function rules(ir: OntologyIr, objectType: string): { name: string; properties: string[]; constraint: string }[] {
  const compiled: CompiledObjectType | undefined = compileOrThrow(stored(ir)).objectTypes.get(objectType);

  if (!compiled) throw new Error(`compileOntology gave no Object Type ${objectType}.`);

  return compiled.uniqueness.map(({ name, properties, constraint }) => ({
    name,
    properties: properties.map((p) => p.apiName),
    constraint,
  }));
}

function refusal(ir: OntologyIr): string {
  try {
    compileOrThrow(stored(ir));
  } catch (error) {
    if (error instanceof CompileError) return error.message;

    throw error;
  }

  throw new Error('compileOntology did not refuse the IR.');
}

describe('the rules of an IR that stock @osdk/maker writes', () => {
  it('ontology/object-link-types/properties#uniqueness-constraints: a rule on 1 Property and a rule on 2 Properties compile, in name order, each with its Properties in API name order and its Postgres name', () => {
    const ir = makerIr();

    expect(rules(ir, INVOICE)).toEqual([
      { name: 'invoiceNumber', properties: ['number'], constraint: 'unique_invoice_invoiceNumber_b8767274' },
      { name: 'numberPerYear', properties: ['number', 'year'], constraint: 'unique_invoice_numberPerYear_20dc6ae5' },
    ]);

    expect(rules(ir, MEMBERSHIP)).toEqual([
      {
        name: 'onePersonPerRole',
        properties: ['personId', 'roleId'],
        constraint: 'unique_membership_onePersonPerRole_74903fac',
      },
    ]);
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: each Property of a rule is the compiled Property of its Object Type', () => {
    const invoice = compileOrThrow(stored(makerIr())).objectTypes.get(INVOICE);

    expect(invoice?.uniqueness[1]?.properties).toEqual([
      invoice?.properties.get('number'),
      invoice?.properties.get('year'),
    ]);
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: an Object Type with no unique type class has no rule', () => {
    const ir = withTypeClasses(MEMBERSHIP, 'personId', []);

    expect(rules(withTypeClasses(MEMBERSHIP, 'roleId', [], ir), MEMBERSHIP)).toEqual([]);
  });
});

describe('the refusals of a rule', () => {
  it('ontology/object-link-types/properties#uniqueness-constraints: publish refuses the kind unique on the primary key', () => {
    expect(refusal(withTypeClasses(INVOICE, 'invoiceId', [unique('byId')]))).toBe(
      `The primary key invoiceId of Object Type ${INVOICE} has the Uniqueness type class byId. The primary key is unique already.`,
    );
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: publish refuses the kind unique on an array Property', () => {
    expect(refusal(withTypeClasses(INVOICE, 'tags', [unique('byTags')]))).toBe(
      `Property tags of Object Type ${INVOICE} is an array and has the Uniqueness type class byTags. A Uniqueness constraint holds no array and no struct.`,
    );
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: publish refuses the kind unique on a struct Property', () => {
    expect(refusal(withTypeClasses(INVOICE, 'address', [unique('byAddress')]))).toBe(
      `Property address of Object Type ${INVOICE} is a struct and has the Uniqueness type class byAddress. A Uniqueness constraint holds no array and no struct.`,
    );
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: publish refuses the kind unique on a struct field', () => {
    const ir = makerIr();

    const fields = unchecked<Json[]>(
      unchecked<{ struct: { structFields: Json[] } }>(propertyOf(ir, INVOICE, 'address')['type']).struct.structFields,
    );

    const city = fields.find((field) => field['apiName'] === 'city');

    if (!city) throw new Error('The struct address has no field city.');

    city['typeClasses'] = [unique('byCity')];

    expect(refusal(ir)).toBe(
      `The struct field city of Property address of Object Type ${INVOICE} has the Uniqueness type class byCity. A Uniqueness constraint holds no struct field.`,
    );
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: publish refuses a rule with an empty name', () => {
    expect(refusal(withTypeClasses(INVOICE, 'year', [unique('')]))).toBe(
      `Property year of Object Type ${INVOICE} has a Uniqueness type class with an empty name. A Uniqueness constraint has a name.`,
    );
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: publish refuses a rule with more than 5 Properties, and accepts 5', () => {
    const ir = makerIr();
    const block = ir.ontology.objectTypes[INVOICE];

    if (!block) throw new Error('The IR has no Invoice.');

    const year = propertyOf(ir, INVOICE, 'year');
    const names = ['a1', 'a2', 'a3', 'a4', 'a5'];

    for (const name of names)
      unchecked<Record<string, Json>>(block.objectType.propertyTypes)[name] = {
        ...structuredClone(year),
        apiName: name,
        typeClasses: [unique('wide')],
      };

    expect(rules(ir, INVOICE).find((rule) => rule.name === 'wide')?.properties).toEqual(names);

    propertyOf(ir, INVOICE, 'year')['typeClasses'] = [unique('numberPerYear'), unique('wide')];

    expect(refusal(ir)).toBe(
      `The Uniqueness constraint wide of Object Type ${INVOICE} has 6 Properties. A Uniqueness constraint has at most 5 Properties.`,
    );
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: publish refuses 2 rules of 1 Object Type with the same set of Properties', () => {
    const ir = withTypeClasses(MEMBERSHIP, 'personId', [unique('onePersonPerRole'), unique('oneRolePerPerson')]);

    expect(
      refusal(withTypeClasses(MEMBERSHIP, 'roleId', [unique('oneRolePerPerson'), unique('onePersonPerRole')], ir)),
    ).toBe(
      `The Uniqueness constraints onePersonPerRole and oneRolePerPerson of Object Type ${MEMBERSHIP} have the same Properties: personId, roleId. 2 Uniqueness constraints of 1 Object Type have 2 different sets of Properties.`,
    );
  });
});

describe('the type classes that compile accepts', () => {
  it('ontology/object-link-types/properties#type-classes: 1 Property in 2 rules compiles, where 1 rule holds the other', () => {
    expect(rules(makerIr(), INVOICE).map(({ name, properties }) => [name, properties])).toEqual([
      ['invoiceNumber', ['number']],
      ['numberPerYear', ['number', 'year']],
    ]);
  });

  it('ontology/object-link-types/properties#type-classes: 1 rule name on 2 Object Types gives 2 rules with 2 Postgres names', () => {
    const ir = withTypeClasses(INVOICE, 'year', [unique('numberPerYear'), unique('onePersonPerRole')]);

    expect(rules(ir, INVOICE).find((rule) => rule.name === 'onePersonPerRole')).toEqual({
      name: 'onePersonPerRole',
      properties: ['year'],
      constraint: 'unique_invoice_onePersonPerRole_01ae3a1a',
    });

    expect(rules(ir, MEMBERSHIP)).toEqual([
      {
        name: 'onePersonPerRole',
        properties: ['personId', 'roleId'],
        constraint: 'unique_membership_onePersonPerRole_74903fac',
      },
    ]);
  });

  it('ontology/object-link-types/properties#type-classes: the same type class 2 times on 1 Property is 1 entry of the rule', () => {
    const ir = withTypeClasses(MEMBERSHIP, 'roleId', [unique('onePersonPerRole'), unique('onePersonPerRole')]);

    expect(rules(ir, MEMBERSHIP)).toEqual([
      {
        name: 'onePersonPerRole',
        properties: ['personId', 'roleId'],
        constraint: 'unique_membership_onePersonPerRole_74903fac',
      },
    ]);
  });

  it('ontology/object-link-types/properties#type-classes: only the exact kind unique makes a rule, so Unique and UNIQUE do nothing, also on the primary key', () => {
    const ir = withTypeClasses(MEMBERSHIP, 'roleId', [
      { kind: 'Unique', name: 'onePersonPerRole' },
      { kind: 'UNIQUE', name: '' },
    ]);

    withTypeClasses(MEMBERSHIP, 'membershipId', [{ kind: 'Unique', name: 'byId' }], ir);

    expect(rules(ir, MEMBERSHIP).map(({ name, properties }) => [name, properties])).toEqual([
      ['onePersonPerRole', ['personId']],
    ]);
  });
});
