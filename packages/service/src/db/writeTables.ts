import type { CompiledLink, CompiledObjectType, JoinTable } from '../ontology/index.ts';
import type { Writer } from './reader.ts';
import { historyName, joinTableOf, schemasOf, tableName } from './readerStore.ts';

type LinkJoin = Extract<CompiledLink['via'], { readonly kind: 'joinTable' }>;

export const WRITE_VERSION = 'random(0, 9223372036854775807)';

export const OPERATION_ID_SQL = `(entry ->> 'operationId') COLLATE "C"`;

export function writeTable(writer: Writer, objectType: CompiledObjectType): string {
  return tableName(schemasOf(writer), objectType.table);
}

export function writeLinkTable(writer: Writer, join: LinkJoin | JoinTable): string {
  return tableName(schemasOf(writer), joinTableOf(join, ['link', 'rows']));
}

export function writeHistoryTable(writer: Writer): string {
  return historyName(schemasOf(writer));
}
