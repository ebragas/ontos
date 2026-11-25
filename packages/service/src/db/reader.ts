import type { Permission, UserId } from '../auth/index.ts';
import { invariant, type AsyncFallible } from '../errors/index.ts';
import type { CompiledPersonAttribute, PersonAttributeName, PersonFact } from '../ontology/index.ts';
import { boundOf, registerBound, tableName } from './readerStore.ts';
import { quoteName, type Db, type DbFailure, type Schemas } from './types.ts';

export interface SqlValues {
  add(value: unknown): string;
}

declare const readerBrand: unique symbol;
declare const writerBrand: unique symbol;

export interface Reader {
  readonly [readerBrand]: true;
}

export interface Writer {
  readonly [writerBrand]: true;
}

interface Person {
  readonly userId: UserId;
  readonly permissions: readonly Permission[];
  readonly attributes: ReadonlyMap<PersonAttributeName, readonly string[]>;
}

export function bindReader(schemas: Schemas, person: Person): { readonly reader: Reader; readonly writer: Writer } {
  return registerBound(schemas, person);
}

export async function* openReader(
  db: Db,
  schemas: Schemas,
  attributes: readonly CompiledPersonAttribute[],
  caller: { readonly user: UserId; readonly permissions: readonly Permission[] },
): AsyncFallible<{ readonly reader: Reader; readonly writer: Writer }, DbFailure> {
  const person = (values: ReadonlyMap<PersonAttributeName, readonly string[]>) =>
    bindReader(schemas, { userId: caller.user, permissions: caller.permissions, attributes: values });

  if (attributes.length === 0 || caller.user.includes('\u0000')) return person(new Map());

  const columns = attributes.map((attribute, index) => `ARRAY(${pathSql(schemas, attribute)}) AS "a${index}"`);

  const [row] = yield* db.query<Record<string, unknown>>({
    text: `SELECT ${columns.join(', ')}`,
    values: [caller.user],
  });

  return person(
    new Map(
      attributes.map(({ name }, index) => {
        const keys = row?.[`a${index}`];

        invariant(
          Array.isArray(keys) && keys.every((key) => typeof key === 'string'),
          `The read of the Person attribute ${name} gave no list of Strings.`,
        );

        return [name, keys as string[]];
      }),
    ),
  );
}

function pathSql(schemas: Schemas, { start, steps }: CompiledPersonAttribute): string {
  const joins: string[] = [];
  let key = `t0.${quoteName(start.keyColumn)}`;

  steps.forEach(({ via, target }, index) => {
    const [from, to] = [`t${index}`, `t${index + 1}`];
    const targetTable = `${tableName(schemas, target.table)} AS ${to}`;
    const targetKey = `${to}.${quoteName(target.keyColumn)}`;

    if (via.kind === 'foreignKeyHere')
      joins.push(`JOIN ${targetTable} ON ${targetKey} = ${from}.${quoteName(via.column)}`);

    if (via.kind === 'foreignKeyOnTarget') joins.push(`JOIN ${targetTable} ON ${to}.${quoteName(via.column)} = ${key}`);

    if (via.kind === 'joinTable') {
      const join = `j${index + 1}`;

      joins.push(`JOIN ${tableName(schemas, via.table)} AS ${join} ON ${join}.${quoteName(via.sourceColumn)} = ${key}`);

      joins.push(`JOIN ${targetTable} ON ${targetKey} = ${join}.${quoteName(via.targetColumn)}`);
    }

    key = targetKey;
  });

  const from = `${tableName(schemas, start.table)} AS t0`;

  return `SELECT DISTINCT ${key}::text FROM ${[from, ...joins].join(' ')} WHERE t0.${quoteName(start.userColumn)} = $1`;
}

export function personValue(reader: Reader, fact: PersonFact): readonly string[] {
  const { person } = boundOf(reader);

  if (fact.kind === 'userId') return [person.userId];

  if (fact.kind === 'permissions') return person.permissions;

  return person.attributes.get(fact.name) ?? [];
}
