import { quoteName, type Db, type DbFailure, type Schemas, type Sql } from '../../db/index.ts';
import type { ApiError, AsyncFallible } from '../../errors/index.ts';
import type { CompiledLinkType, CompiledObjectType, CompiledOntology, CompiledProperty } from '../../ontology/index.ts';
import type { SchemaMigration } from '../index.ts';
import type { Change } from '../plan.ts';
import { activeStatus, needsMigration } from './migrationChecks.ts';
import type { StoredRule } from './storedRules.ts';
import { objectTable } from './tableSql.ts';

type Kind = SchemaMigration['type'];

export type CheckFailure = ApiError | DbFailure;

export class Stored {
  private readonly db: Db;
  private readonly schemas: Schemas;

  constructor(db: Db, schemas: Schemas) {
    this.db = db;
    this.schemas = schemas;
  }

  private async *exists(text: string, values: unknown[] = []): AsyncFallible<boolean, DbFailure> {
    const [row] = yield* this.db.query<{ found: boolean }>({ text: `SELECT EXISTS (${text}) AS found`, values });

    return row?.found ?? false;
  }

  hasObjects(type: CompiledObjectType): AsyncFallible<boolean, DbFailure> {
    return this.exists(`SELECT 1 FROM ${objectTable(this.schemas, type.table)}`);
  }

  holdsValues(type: CompiledObjectType, property: CompiledProperty): AsyncFallible<boolean, DbFailure> {
    return this.exists(
      `SELECT 1 FROM ${objectTable(this.schemas, type.table)} WHERE ${quoteName(property.column)} IS NOT NULL`,
    );
  }

  fieldHoldsValues(
    type: CompiledObjectType,
    property: CompiledProperty,
    field: string,
  ): AsyncFallible<boolean, DbFailure> {
    const column = quoteName(property.column);

    return this.exists(
      `SELECT 1 FROM ${objectTable(this.schemas, type.table)} WHERE (${column} -> $1) IS NOT NULL AND (${column} -> $1) <> 'null'::jsonb`,
      [field],
    );
  }

  hasRows(table: string): AsyncFallible<boolean, DbFailure> {
    return this.exists(`SELECT 1 FROM ${objectTable(this.schemas, table)}`);
  }

  hasHistory(objectType: string): AsyncFallible<boolean, DbFailure> {
    return this.exists(`SELECT 1 FROM ${quoteName(this.schemas.engine)}.edit_history WHERE object_type = $1`, [
      objectType,
    ]);
  }

  async *primaryKeyName(table: string): AsyncFallible<string | undefined, DbFailure> {
    const [row] = yield* this.db.query<{ name: string }>({
      text: "SELECT conname AS name FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'p'",
      values: [objectTable(this.schemas, table)],
    });

    return row?.name;
  }

  async *uniqueConstraintNames(table: string): AsyncFallible<ReadonlySet<string>, DbFailure> {
    const rows = yield* this.db.query<{ name: string }>({
      text: "SELECT conname AS name FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'u'",
      values: [objectTable(this.schemas, table)],
    });

    return new Set(rows.map((row) => row.name));
  }
}

export class Plan {
  readonly changes: Change[];

  constructor(changes: readonly Change[]) {
    this.changes = [...changes];
  }

  has(description: string): boolean {
    return this.changes.some((change) => change.description === description);
  }

  addRule(description: string, rule: StoredRule): void {
    const index = this.changes.findIndex((change) => change.description === description);
    const change = this.changes[index];

    if (change) this.changes[index] = { ...change, storedRules: [...(change.storedRules ?? []), rule] };
  }

  use(description: string, migration: SchemaMigration, statements?: readonly Sql[]): void {
    const index = this.changes.findIndex((change) => change.description === description);
    const change = this.changes[index];

    if (change) this.changes[index] = { ...change, migration, ...(statements ? { statements } : {}) };
  }

  prepend(table: string, statement: Sql): void {
    const index = this.changes.findIndex((change) => change.table === table);
    const change = this.changes[index];

    if (change) this.changes[index] = { ...change, statements: [statement, ...change.statements] };
  }

  remove(description: string): number {
    const index = this.changes.findIndex((change) => change.description === description);

    if (index >= 0) this.changes.splice(index, 1);

    return index;
  }

  replace(description: string, other: string, change: Change): void {
    const index = this.remove(description);

    this.remove(other);

    this.changes.splice(index < 0 ? this.changes.length : index, 0, change);
  }

  add(change: Change): void {
    this.changes.push(change);
  }

  moveToEnd(description: string): void {
    const index = this.changes.findIndex((change) => change.description === description);

    if (index >= 0) this.changes.push(...this.changes.splice(index, 1));
  }
}

export class Check {
  readonly schemas: Schemas;
  readonly plan: Plan;
  readonly stored: Stored;
  readonly hasStoredValues: boolean;
  private readonly migrations: readonly SchemaMigration[];

  constructor(
    db: Db,
    schemas: Schemas,
    planned: readonly Change[],
    migrations: readonly SchemaMigration[],
    hasStoredValues: boolean,
  ) {
    this.schemas = schemas;
    this.hasStoredValues = hasStoredValues;
    this.plan = new Plan(planned);
    this.stored = new Stored(db, schemas);
    this.migrations = migrations;
  }

  find<K extends Kind>(
    kind: K,
    matches: (m: Extract<SchemaMigration, { type: K }>) => boolean,
  ): Extract<SchemaMigration, { type: K }> | undefined {
    return this.migrations.find(
      (m): m is Extract<SchemaMigration, { type: K }> =>
        m.type === kind && matches(m as Extract<SchemaMigration, { type: K }>),
    );
  }

  async *require(
    change: string,
    migration: SchemaMigration | undefined,
    breaks: () => AsyncFallible<boolean, DbFailure>,
    kinds: readonly Kind[],
  ): AsyncFallible<void, CheckFailure> {
    if (migration) this.plan.use(change, migration);
    else if (yield* breaks()) return yield needsMigration(change, kinds);
  }

  async *deletedObjectType(before: CompiledObjectType): AsyncFallible<void, CheckFailure> {
    const name = before.apiName;
    const change = `Delete Object Type ${name}`;

    if (before.status === 'active') return yield activeStatus(change);

    const drop = this.find('dropAllPatches', (m) => m.objectType === name);

    yield* this.require(change, drop, () => this.stored.hasObjects(before), ['dropAllPatches']);
  }

  async *deletedLinkType(link: CompiledLinkType, ontology: CompiledOntology): AsyncFallible<void, CheckFailure> {
    const change = `Delete Link Type ${link.apiName}`;

    if (!this.plan.has(change)) return;

    if (!ontology.linkTypes.has(link.apiName) && link.status === 'active') return yield activeStatus(change);

    const { storage } = link;

    if (storage.kind !== 'joinTable') return;

    const drop = this.find('dropLinks', (m) => m.linkType === link.apiName);

    yield* this.require(change, drop, () => this.stored.hasRows(storage.table), ['dropLinks']);
  }
}
