import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  bindReader,
  historySource,
  linkSource,
  readSource,
  writeHistoryTable,
  writeLinkTable,
  writeTable,
  type Reader,
  type Schemas,
  type SqlValues,
  type Writer,
} from '../db/index.ts';
import type { Ctx, McpCtx, Route, TrustedInput, WriteCtx } from '../handler/index.ts';

import { accountWith, compileOrThrow, irOf, NS, stored, stringProperty } from '../ontology/stored.test-utils.ts';
import { SCHEMAS } from '../service.test-utils.ts';
import { UserId } from './caller.ts';

const src = fileURLToPath(new URL('../', import.meta.url));

type HoldsNone<T> = Extract<T[keyof T], Schemas | Writer> extends never ? true : false;

type ReaderRequired<T> = object extends Pick<T, Extract<keyof T, 'reader'>> ? false : true;

const ctxHoldsNone: HoldsNone<Ctx> = true;
const mcpCtxHoldsNone: HoldsNone<McpCtx> = true;
const trustedHoldsNone: HoldsNone<TrustedInput> = true;
const ctxNeedsReader: ReaderRequired<Ctx> = true;
const trustedNeedsReader: ReaderRequired<TrustedInput> = true;

const { reader, writer } = bindReader(SCHEMAS, {
  userId: UserId.parse('person-1'),
  permissions: [],
  attributes: new Map(),
});

const account = compileOrThrow(stored(irOf(accountWith(stringProperty('note'))))).objectTypes.get(`${NS}Account`);

if (!account) throw new Error('The test IR has no Account.');

const CONTACTS = {
  kind: 'joinTable',
  table: 'account_contacts',
  sourceColumn: 'account_id',
  targetColumn: 'contact_id',
} as const;

const noValues: SqlValues = {
  add: () => {
    throw new Error('A type with no policy binds no value.');
  },
};

function moduleFiles(module: string): { readonly path: string; readonly text: string }[] {
  return readdirSync(`${src}${module}`, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !/\.(test|test-utils|fixture)\.ts$/.test(file))
    .map((file) => ({ path: `${module}/${file}`, text: readFileSync(`${src}${module}/${file}`, 'utf8') }));
}

describe('the request context', () => {
  it('service/code-layout#seams: ctx and the input of handleTrusted hold the Reader as the required field reader, and no schema name', () => {
    expectTypeOf<Ctx['reader']>().toEqualTypeOf<Reader>();

    expectTypeOf<TrustedInput['reader']>().toEqualTypeOf<Reader>();

    expect([ctxNeedsReader, trustedNeedsReader, ctxHoldsNone, mcpCtxHoldsNone, trustedHoldsNone]).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('service/code-layout#seams: only the context of an apply holds a Writer', () => {
    expectTypeOf<WriteCtx['writer']>().toEqualTypeOf<Writer>();

    expectTypeOf<WriteCtx>().toExtend<Ctx>();

    const readRoute = (_input: unknown, ctx: WriteCtx) => Promise.resolve(Response.json(ctx.caller));
    // @ts-expect-error A read route gets a Ctx, so it cannot ask for a Writer.
    const route: Route = { method: 'GET', path: '/x', access: 'ontology', run: readRoute };

    expect([ctxHoldsNone, trustedHoldsNone, route.access]).toEqual([true, true, 'ontology']);
  });
});

describe('the reads and the write names of db/source.ts', () => {
  it('service/code-layout#seams: each read takes a Reader, and each write name takes a Writer', () => {
    expectTypeOf(readSource).parameter(0).toEqualTypeOf<Reader>();

    expectTypeOf(linkSource).parameter(0).toEqualTypeOf<Reader>();

    expectTypeOf(historySource).parameter(0).toEqualTypeOf<Reader>();

    expectTypeOf(writeTable).parameter(0).toEqualTypeOf<Writer>();

    expectTypeOf(writeLinkTable).parameter(0).toEqualTypeOf<Writer>();

    expectTypeOf(writeHistoryTable).parameter(0).toEqualTypeOf<Writer>();

    // @ts-expect-error A Writer is not a Reader.
    expect(() => readSource(writer, account, noValues)).toThrow('not a Reader');
    // @ts-expect-error A Reader is not a Writer.
    expect(() => writeTable(reader, account)).toThrow('not a Writer');
    expect(() => readSource({} as Reader, account, noValues)).toThrow('not a Reader');
    expect(() => writeHistoryTable({} as Writer)).toThrow('not a Writer');
  });

  it('service/code-layout#seams: a join table name comes only from a join that compile made, so an Object Type table is no join table', () => {
    // @ts-expect-error A table name is not a join.
    expect(() => linkSource(reader, 'account')).toThrow('not a join table');
    // @ts-expect-error An Object Type is not a join.
    expect(() => linkSource(reader, account)).toThrow('not a join table');

    // @ts-expect-error The join rows of a delete are not the join of a read.
    expect(() => linkSource(reader, { table: 'account_contacts', columns: ['account_id'] })).toThrow(
      'not a join table',
    );

    // @ts-expect-error A table name is not a join.
    expect(() => writeLinkTable(writer, 'account')).toThrow('not a join table');
    // @ts-expect-error An Object Type is not a join.
    expect(() => writeLinkTable(writer, account)).toThrow('not a join table');
  });

  it('service/code-layout#seams: for a type with no policy, readSource, linkSource, and historySource give the table text of today, byte for byte', () => {
    expect(readSource(reader, account, noValues)).toBe('"ontology_1_objects"."account"');
    expect(linkSource(reader, CONTACTS)).toBe('"ontology_1_objects"."account_contacts"');
    expect(historySource(reader, account, noValues)).toBe('"ontology_1_engine".edit_history');
    expect(writeTable(writer, account)).toBe(readSource(reader, account, noValues));
    expect(writeLinkTable(writer, CONTACTS)).toBe(linkSource(reader, CONTACTS));

    expect(writeLinkTable(writer, { table: 'account_contacts', columns: ['account_id'] })).toBe(
      linkSource(reader, CONTACTS),
    );

    expect(writeHistoryTable(writer)).toBe(historySource(reader, account, noValues));
  });

  it('service/code-layout#seams: no route module names an Object Type table, a join table, or edit_history; db/source.ts does', () => {
    const raw = [
      /\bedit_history\b/,
      /\bschemas\.(?:object|engine)\b/,
      /\bSchemas\b/,
      /quoteName\([^)]*\.table\)/,
      /\.table\b/,
      /\b(?:tableName|joinTableName)\(/,
    ];

    const routeFiles = [
      ...['objectSets', 'actions', 'functions', 'mcp', 'handler'].flatMap(moduleFiles),
      ...['routes.ts'].map((file) => ({
        path: `ontology/${file}`,
        text: readFileSync(`${src}ontology/${file}`, 'utf8'),
      })),
    ];

    const named = routeFiles.flatMap(({ path, text }) =>
      raw.filter((pattern) => pattern.test(text)).map((pattern) => `${path} ${String(pattern)}`),
    );

    expect(named).toEqual([]);

    const seam = readFileSync(`${src}db/source.ts`, 'utf8');

    expect(raw.slice(0, 2).map((pattern) => pattern.test(seam))).toEqual([true, true]);
  });
});

describe('the CLI bundle', () => {
  it('service/code-layout#seams: the ontology module imports only types from db', () => {
    const valueImports = moduleFiles('ontology').flatMap(({ path, text }) =>
      [...text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from '\.\.\/db\/[^']*'/gm)].map(
        (match) => `${path}: ${match[0]}`,
      ),
    );

    expect(valueImports).toEqual([]);
  });
});
