import type { Sql } from '../../db/index.ts';
import { quoteName } from '../../db/index.ts';
import type { CompiledObjectSet } from './objectSet.ts';
import { ROW, type ObjectReader } from './objects.ts';
import type { SortKey } from './order.ts';
import { Params } from './sql.ts';

export * from './pageToken.ts';

const TOTAL = '__total';
const OBJECT = '__object';
const SET = '__set';

export function pageSql(
  set: CompiledObjectSet,
  reader: ObjectReader,
  keys: readonly SortKey[],
  pageSize: number,
  after?: readonly unknown[],
  includeTotalCount = true,
): Sql {
  const params = new Params();
  const materialized = set.hasComputedDerived();
  const cte = materialized ? `WITH ${SET} AS MATERIALIZED (SELECT ${ROW}.* FROM ${set.source(params)} AS ${ROW}) ` : '';

  const total = includeTotalCount
    ? `SELECT count(*)::text AS ${TOTAL} FROM ${materialized ? SET : set.source(params)} AS ${ROW}`
    : undefined;

  const source = materialized ? SET : set.source(params);
  const values = keys.map((key, index) => `${key.value} AS ${quoteName(sortColumn(index))}`).join(', ');
  const where = after === undefined ? '' : ` WHERE ${afterSql(keys, after, params)}`;
  const order = keys.map((key) => `${key.sql} ${orderOf(key)}`).join(', ');
  const limit = params.add(pageSize + 1);
  const orderValues = keys.map((key, index) => `${key.sql} AS ${quoteName(orderColumn(index))}`).join(', ');
  const outerOrder = keys.map((key, index) => `page.${quoteName(orderColumn(index))} ${orderOf(key)}`).join(', ');

  const page = set.hasPageDerived()
    ? `SELECT ${reader.columns(params)}, ${values}, ${orderValues}, TRUE AS ${OBJECT} FROM ${set.pageSource(`(SELECT ${ROW}.* FROM ${source} AS ${ROW}${where} ORDER BY ${order} LIMIT ${limit})`, params)} AS ${ROW} OFFSET 0`
    : `SELECT ${reader.columns(params)}, ${values}, ${orderValues}, TRUE AS ${OBJECT} FROM ${source} AS ${ROW}${where} ORDER BY ${order} LIMIT ${limit}`;

  if (total === undefined) {
    return {
      text: `${cte}SELECT * FROM (${page}) AS page ORDER BY ${outerOrder}`,
      values: params.values,
    };
  }

  return {
    text: `${cte}SELECT * FROM (${total}) AS total LEFT JOIN (${page}) AS page ON TRUE ORDER BY ${outerOrder}`,
    values: params.values,
  };
}

function orderOf(key: SortKey): string {
  return key.direction === 'asc' ? 'ASC NULLS FIRST' : 'DESC NULLS LAST';
}

function orderColumn(index: number): string {
  return `__order${index}`;
}

export function totalOf(row: Readonly<Record<string, unknown>>): string {
  return String(row[TOTAL]);
}

export function holdsObject(row: Readonly<Record<string, unknown>>): boolean {
  return row[OBJECT] === true;
}

export function sortValues(keys: readonly SortKey[], row: Readonly<Record<string, unknown>>): unknown[] {
  return keys.map((_, index) => row[sortColumn(index)] ?? null);
}

function sortColumn(index: number): string {
  return `__sort${index}`;
}

function afterSql(keys: readonly SortKey[], after: readonly unknown[], params: Params): string {
  const same: string[] = [];
  const later: string[] = [];

  keys.forEach((key, index) => {
    const value = after[index];
    const placeholder = value === null ? undefined : params.add(value);
    const laterOnKey = laterSql(key, placeholder);

    if (laterOnKey !== undefined) later.push(`(${[...same, laterOnKey].join(' AND ')})`);

    same.push(placeholder === undefined ? `${key.sql} IS NULL` : `${key.sql} = ${placeholder}`);
  });

  return later.length === 0 ? 'FALSE' : `(${later.join(' OR ')})`;
}

function laterSql(key: SortKey, placeholder: string | undefined): string | undefined {
  if (key.direction === 'asc')
    return placeholder === undefined ? `${key.sql} IS NOT NULL` : `${key.sql} > ${placeholder}`;

  return placeholder === undefined ? undefined : `(${key.sql} < ${placeholder} OR ${key.sql} IS NULL)`;
}
