import { describe, expect, it } from 'vitest';
import { columnName, indexName, joinTableName, snakeCase, tableName } from './index.ts';
import { UNIQUE_STRING_BYTES } from './compiled/objects.ts';

describe('table names', () => {
  it('makes the table name from the part after the API namespace', () => {
    expect(tableName('com.example.crm.WorkOrder')).toBe('work_order');
    expect(tableName('com.example.twin.Account')).toBe('account');
  });

  it('makes the column name of a Property', () => {
    expect(columnName('startDate')).toBe('start_date');
    expect(columnName('accountId')).toBe('account_id');
  });

  it('makes the join table name of a Link Type', () => {
    expect(joinTableName('technicianCertifications')).toBe('technician_certifications');
  });

  it('splits a run of capitals before a new word', () => {
    expect(snakeCase('HTTPServer')).toBe('http_server');
    expect(snakeCase('item2Name')).toBe('item2_name');
  });

  it('truncates a name to 63 bytes, as Postgres does', () => {
    expect(snakeCase('a'.repeat(70))).toHaveLength(63);
    expect(new TextEncoder().encode(snakeCase('é'.repeat(40))).length).toBeLessThanOrEqual(63);
  });
});

describe('index names', () => {
  it('service/storage#indexes: gives each kind of today the name of today', () => {
    expect(indexName('pk', 'invoice')).toBe('pk_invoice_6b53f2d0');
    expect(indexName('trgm', 'invoice', 'number')).toBe('trgm_invoice_number_51b5e195');
    expect(indexName('fk', 'engagement', 'account_id')).toBe('fk_engagement_account_id_5dc9719a');
    expect(indexName('join', 'account_partners', 'a_account_id')).toBe('join_account_partners_a_account_id_c06eaf8e');
    expect(indexName('policy', 'invoice', 'owner_ids')).toBe('policy_invoice_owner_ids_43a25e06');
  });

  it('service/storage#indexes: keeps 2 pairs that join to the same text apart', () => {
    expect(indexName('trgm', 'order', 'item_name')).toBe('trgm_order_item_name_cd7239a0');
    expect(indexName('trgm', 'order_item', 'name')).toBe('trgm_order_item_name_3d3df0b7');
  });

  it('service/storage#indexes: cuts a long name to 54 bytes, and a cut inside a multibyte character leaves no replacement character', () => {
    expect(indexName('trgm', 't'.repeat(30), 'c'.repeat(40))).toBe(
      'trgm_tttttttttttttttttttttttttttttt_cccccccccccccccccc_2c392594',
    );

    expect(indexName('trgm', 'tabelle', 'größe'.repeat(10))).toBe(
      'trgm_tabelle_größegrößegrößegrößegrößegröß_69e86f87',
    );
  });

  it('service/storage#indexes: names a unique constraint from its rule name, so 2 Object Types can use 1 rule name', () => {
    expect(indexName('unique', 'invoice', 'invoiceNumber')).toMatch(/^unique_invoice_invoiceNumber_[0-9a-f]{8}$/);
    expect(indexName('unique', 'invoice', 'invoiceNumber')).not.toBe(indexName('unique', 'receipt', 'invoiceNumber'));
  });

  it('service/storage#indexes: the name of a Uniqueness constraint is unique_<table>_<rule> and 8 hex digits of the SHA-1, cut to fit 63 bytes', () => {
    expect(indexName('unique', 'membership', 'onePersonPerRole')).toBe('unique_membership_onePersonPerRole_74903fac');
    expect(indexName('unique', 'membership', 'r'.repeat(80))).toBe(`unique_membership_${'r'.repeat(36)}_705a099e`);
  });

  it('service/storage#indexes: 5 Strings of the most bytes of a unique rule fit 1 index entry of 2,704 bytes', () => {
    expect(5 * UNIQUE_STRING_BYTES).toBeLessThanOrEqual(2704);
  });
});
