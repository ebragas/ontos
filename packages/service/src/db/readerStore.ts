import type { Permission, UserId } from '../auth/index.ts';
import { invariant } from '../errors/index.ts';
import type { CompiledLink, JoinTable, PersonAttributeName } from '../ontology/index.ts';
import type { Reader, Writer } from './reader.ts';
import { quoteName, type Schemas } from './types.ts';

interface Person {
  readonly userId: UserId;
  readonly permissions: readonly Permission[];
  readonly attributes: ReadonlyMap<PersonAttributeName, readonly string[]>;
}

interface Bound {
  readonly schemas: Schemas;
  readonly person: Person;
}

const readers = new WeakMap<Reader, Bound>();
const writers = new WeakMap<Writer, Schemas>();

export function registerBound(schemas: Schemas, person: Person): { readonly reader: Reader; readonly writer: Writer } {
  const reader = Object.freeze({}) as Reader;
  const writer = Object.freeze({}) as Writer;

  readers.set(reader, { schemas, person });

  writers.set(writer, schemas);

  return { reader, writer };
}

export function boundOf(reader: Reader): Bound {
  const bound = readers.get(reader);

  invariant(bound, 'This value is not a Reader of bindReader.');

  return bound;
}

export function schemasOf(writer: Writer): Schemas {
  const schemas = writers.get(writer);

  invariant(schemas, 'This value is not a Writer of bindReader.');

  return schemas;
}

export function tableName(schemas: Schemas, table: string): string {
  return `${quoteName(schemas.object)}.${quoteName(table)}`;
}

export function historyName(schemas: Schemas): string {
  return `${quoteName(schemas.engine)}.edit_history`;
}

type LinkJoin = Extract<CompiledLink['via'], { readonly kind: 'joinTable' }>;

export function joinTableOf(join: LinkJoin | JoinTable, forms: readonly ('link' | 'rows')[]): string {
  const value: unknown = join;
  const isRecord = typeof value === 'object' && value !== null;

  const form =
    isRecord && 'kind' in value && value.kind === 'joinTable'
      ? 'link'
      : isRecord && 'columns' in value && Array.isArray(value.columns)
        ? 'rows'
        : undefined;

  invariant(form !== undefined && forms.includes(form), 'This value is not a join table of a compiled Link Type.');

  return join.table;
}
