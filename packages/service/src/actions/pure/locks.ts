import { quoteName, writeTable, type Sql, type Writer } from '../../db/index.ts';
import { VERSION_COLUMN } from '../../errors/index.ts';
import type { CompiledOntology, ObjectTypeApiName, PrimaryKey } from '../../ontology/index.ts';
import type { ObjectLocator } from '../edit.ts';
import { propertyColumns } from './reads.ts';
import { objectTypeOf } from './shared.ts';

export interface LockTarget {
  readonly object: ObjectLocator;
  readonly version: string;
  readonly stored: boolean;
}

export interface LockBatch {
  readonly objectType: ObjectTypeApiName;
  readonly stored: boolean;
  readonly targets: readonly { readonly primaryKey: PrimaryKey; readonly version: string }[];
}

export function lockBatches(targets: readonly LockTarget[]): LockBatch[] {
  const ordered = [...targets].sort(
    (a, b) => compare(a.object.objectType, b.object.objectType) || compare(a.object.primaryKey, b.object.primaryKey),
  );

  const batches: {
    readonly objectType: ObjectTypeApiName;
    readonly stored: boolean;
    readonly targets: { readonly primaryKey: PrimaryKey; readonly version: string }[];
  }[] = [];

  for (const target of ordered) {
    const last = batches.at(-1);
    const entry = { primaryKey: target.object.primaryKey, version: target.version };

    if (last && last.objectType === target.object.objectType && last.stored === target.stored) {
      last.targets.push(entry);
    } else {
      batches.push({ objectType: target.object.objectType, stored: target.stored, targets: [entry] });
    }
  }

  return batches;
}

export function lockBatchSql(writer: Writer, ontology: CompiledOntology, batch: LockBatch): Sql {
  const objectType = objectTypeOf(ontology, batch.objectType);
  const pk = quoteName(objectType.primaryKey.column);
  const keys = batch.targets.map((target) => target.primaryKey);
  const versions = batch.targets.map((target) => target.version);
  const select = batch.stored ? `o.${pk} AS "primaryKey", ${propertyColumns(objectType)}` : '1 AS linked';
  const mode = batch.stored ? 'FOR UPDATE' : 'FOR KEY SHARE';

  return {
    text: `SELECT ${select} FROM ${writeTable(writer, objectType)} AS o JOIN unnest($1::text[], $2::bigint[]) WITH ORDINALITY AS u(__pk, __ver, __ord) ON o.${pk} = u.__pk AND o.${quoteName(VERSION_COLUMN)} = u.__ver ORDER BY u.__ord ${mode}`,
    values: [keys, versions],
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
