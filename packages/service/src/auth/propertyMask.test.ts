import type { OntologyIr } from '@osdk/client.unstable';
import { describe, expect, it } from 'vitest';
import { bindReader, readSource, type SqlValues } from '../db/index.ts';

import {
  compileOrThrow,
  NS,
  policiesIr,
  propertyPoliciesIr,
  stored,
  twinFunctions,
} from '../ontology/stored.test-utils.ts';
import { SCHEMAS } from '../service.test-utils.ts';
import { UserId } from './caller.ts';

const propertyPoliciesIrOnce = propertyPoliciesIr();

const { reader } = bindReader(SCHEMAS, {
  userId: UserId.parse('user_ann'),
  permissions: ['member'],
  attributes: new Map(),
});

function source(ir: OntologyIr, apiName: string): { text: string; values: unknown[] } {
  const functions = ir === propertyPoliciesIrOnce ? {} : { functions: twinFunctions('0.6.3') };
  const objectType = compileOrThrow(stored(ir, functions)).objectTypes.get(`${NS}${apiName}`);

  if (!objectType) throw new Error(`compile gave no ${apiName}.`);

  const values: unknown[] = [];
  const add: SqlValues['add'] = (value) => `$${values.push(value)}`;

  return { text: readSource(reader, objectType, { add }), values };
}

describe('the text of readSource', () => {
  it('a type with only an object security policy keeps the text of staging: each column of its rows, with no mask', () => {
    expect(source(policiesIr(), 'Account').text).toMatch(
      /^\(SELECT s\.\* FROM "ontology_1_objects"\."account" AS s WHERE /,
    );
  });

  it('ontology/object-security-policies#hidden-property-values: a type with only property security policies lists each column, masks each hidden one, and keeps each row', () => {
    const { text, values } = source(propertyPoliciesIrOnce, 'Account');
    const readers = `coalesce(array_remove(s."readers", NULL), '{}')`;
    const pay = `((cardinality($1::text[]) > 0 AND cardinality($2::text[]) > 0 AND $1::text[] && $2::text[]) OR (s."owner_id" IS NOT NULL AND cardinality($3::text[]) = 1 AND s."owner_id" = ($3::text[])[1]) OR (cardinality(${readers}) > 0 AND cardinality($4::text[]) > 0 AND ${readers} @> $4::text[]))`;

    expect(text.startsWith(`(SELECT s."account_id", CASE WHEN ${pay} THEN s."name" END AS "name", `)).toBe(true);

    expect(text).toMatch(
      /, s\."owner_id", s\."readers", s\."tags", CASE WHEN .* THEN s\."notes" END AS "notes", .* THEN s\."active" END AS "active", s\."__version" FROM "ontology_1_objects"\."account" AS s\)$/,
    );

    expect(text.match(/CASE WHEN/g)).toHaveLength(11);
    expect(text).not.toMatch(/WHERE/);
    expect(values.slice(0, 4)).toEqual([['admin'], ['member'], ['user_ann'], ['user_ann']]);
  });

  it('ontology/object-security-policies#hidden-property-values: the twin hides a Property of each Property type, and readSource masks each one', () => {
    const compiled = compileOrThrow(stored(propertyPoliciesIrOnce));

    const hidden = [...compiled.objectTypes.values()].flatMap((objectType) =>
      [...objectType.properties.values()]
        .filter((property) => property.policy !== undefined)
        .map((property) => ({ objectType, property })),
    );

    expect([...new Set(hidden.map(({ property }) => property.type.kind))].sort()).toEqual([
      'array',
      'boolean',
      'date',
      'decimal',
      'double',
      'integer',
      'string',
      'struct',
      'timestamp',
    ]);

    for (const { objectType, property } of hidden) {
      expect(readSource(reader, objectType, { add: () => '$1' })).toContain(
        ` THEN s."${property.column}" END AS "${property.column}"`,
      );
    }
  });

  it('a type with both policies masks each hidden column and keeps the WHERE of its object security policy', () => {
    const { text } = source(propertyPoliciesIrOnce, 'Engagement');

    expect(text).toMatch(
      /^\(SELECT s\."engagement_id", CASE WHEN .* THEN s\."account_id" END AS "account_id", s\."title", CASE WHEN .* THEN s\."amount" END AS "amount", s\."status", s\."__version" FROM "ontology_1_objects"\."engagement" AS s WHERE /,
    );
  });
});
