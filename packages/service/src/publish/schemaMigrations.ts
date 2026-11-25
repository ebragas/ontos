import { quoteName, WRITE_VERSION, type Db, type DbFailure, type Schemas, type Sql } from '../db/index.ts';
import { VERSION_COLUMN, type ApiError, type AsyncFallible, type Fallible } from '../errors/index.ts';
import type { CompiledObjectType, CompiledOntology, CompiledProperty, PropertyType } from '../ontology/index.ts';
import type { SchemaMigration } from './index.ts';
import type { Change } from './plan.ts';
import {
  createPolicyIndex,
  createTextIndex,
  dropPolicyIndex,
  dropTextIndex,
  hasPolicyIndex,
  hasTextIndex,
} from './schema/indexes.ts';
import {
  activeStatus,
  checkActionType,
  checkLinkSides,
  invalidMove,
  needsMigration,
} from './schema/migrationChecks.ts';
import { Check, type CheckFailure } from './schema/migrationState.ts';
import { uniquenessChanges, valueTypeChange } from './schema/objectChanges.ts';
import { requiredRule, valueTypeRule, type StoredRule } from './schema/storedRules.ts';
import { canonical, isNewColumn, objectTable, primaryKeyConstraint } from './schema/tableSql.ts';

function isRequired(property: CompiledProperty, type: CompiledObjectType): boolean {
  return property.required || property.apiName === type.primaryKey.apiName;
}

function sameType(a: PropertyType, b: PropertyType): boolean {
  return canonical(a) === canonical(b);
}

class ObjectTypeCheck {
  private readonly check: Check;
  private readonly before: CompiledObjectType;
  private readonly after: CompiledObjectType;
  private readonly name: string;
  private readonly of: string;
  private readonly table: string;
  private readonly storedTable: string;
  private readonly keyChanged: boolean;
  private readonly keyDrop: SchemaMigration | undefined;
  private readonly newProperties: CompiledProperty[];
  private readonly moved = new Map<string, string>();

  constructor(check: Check, before: CompiledObjectType, after: CompiledObjectType) {
    this.check = check;
    this.before = before;
    this.after = after;
    this.name = before.apiName;
    this.of = `of Object Type ${before.apiName}`;
    this.table = objectTable(check.schemas, before.table);
    this.storedTable = `${check.schemas.object}.${before.table}`;
    this.keyChanged = before.primaryKey.apiName !== after.primaryKey.apiName;
    this.keyDrop = this.keyChanged ? check.find('dropAllPatches', (m) => m.objectType === before.apiName) : undefined;
    this.newProperties = [...after.properties.values()].filter((p) => !before.properties.has(p.apiName));
  }

  async *run(): AsyncFallible<void, CheckFailure> {
    yield* this.keyNeedsDrop();

    yield* this.deletedProperties();

    yield* this.derivedProperties();

    yield* this.properties();

    if (this.keyChanged) yield* this.primaryKey();

    if (this.before.editsHistory && !this.after.editsHistory) yield* this.editHistoryOff();

    yield* this.uniqueness();
  }

  private async *uniqueness(): AsyncFallible<void, DbFailure> {
    if (this.before.uniqueness.length === 0 && this.after.uniqueness.length === 0) return;

    const existing = this.check.hasStoredValues
      ? yield* this.check.stored.uniqueConstraintNames(this.before.table)
      : new Set(this.before.uniqueness.map((rule) => rule.constraint));

    for (const change of uniquenessChanges(
      this.check.schemas,
      this.before,
      this.after,
      this.moved,
      this.keyDrop !== undefined,
      existing,
    ))
      this.check.plan.add(change);
  }

  private isMoveTarget(apiName: string): boolean {
    return [...this.moved.values()].includes(apiName);
  }

  private async *holdsValues(property: CompiledProperty): AsyncFallible<boolean, DbFailure> {
    if (this.keyDrop) return false;

    return yield* this.check.stored.holdsValues(this.before, property);
  }

  private async *fieldHoldsValues(property: CompiledProperty, field: string): AsyncFallible<boolean, DbFailure> {
    if (this.keyDrop) return false;

    return yield* this.check.stored.fieldHoldsValues(this.before, property, field);
  }

  private required(property: CompiledProperty, columnIsNew = false): StoredRule[] {
    return this.keyDrop ? [] : [requiredRule(this.before, property, columnIsNew)];
  }

  private valueTypeRules(
    stored: CompiledProperty,
    next: CompiledProperty,
    change = valueTypeChange(stored, next, this.name),
  ): StoredRule[] {
    const valueType = next.valueType;

    return this.keyDrop || !valueType || !change?.checksStoredValues
      ? []
      : [valueTypeRule(this.before, stored, valueType)];
  }

  private addRules(change: string, rules: readonly StoredRule[]): void {
    for (const rule of rules) this.check.plan.addRule(change, rule);
  }

  private dropOf(property: string) {
    return this.check.find('dropProperty', (m) => m.objectType === this.name && m.property === property);
  }

  private async *keyNeedsDrop(): AsyncFallible<void, CheckFailure> {
    if (this.keyChanged && !this.keyDrop && (yield* this.check.stored.hasObjects(this.before))) {
      return yield needsMigration(`Change the primary key ${this.of}`, ['dropAllPatches']);
    }
  }

  private async *deletedProperties(): AsyncFallible<void, CheckFailure> {
    for (const old of this.before.properties.values()) {
      if (!this.after.properties.has(old.apiName)) yield* this.deletedProperty(old);
    }
  }

  private async *deletedProperty(old: CompiledProperty): AsyncFallible<void, CheckFailure> {
    const move = yield* this.moveOf(old);
    const target = move && this.newProperties.find((p) => p.apiName === move.target && sameType(old.type, p.type));

    if (move && target) yield* this.move(old, target, move);
    else yield* this.deleteProperty(old);
  }

  private *moveOf(
    old: CompiledProperty,
  ): Fallible<Extract<SchemaMigration, { type: 'renameProperty' }> | undefined, ApiError> {
    const move = this.check.find('renameProperty', (m) => m.objectType === this.name && m.source === old.apiName);

    if (!move) return undefined;

    const change = `Move Property ${old.apiName} to ${move.target} ${this.of}`;

    if (old.apiName === this.before.primaryKey.apiName) return yield invalidMove(change, { primaryKey: old.apiName });

    if (this.isMoveTarget(move.target)) return yield invalidMove(change, { target: move.target });

    return move;
  }

  private async *move(
    old: CompiledProperty,
    target: CompiledProperty,
    move: SchemaMigration,
  ): AsyncFallible<void, CheckFailure> {
    const change = `Move Property ${old.apiName} to ${target.apiName} ${this.of}`;

    if (old.status.type === 'active') return yield activeStatus(change);

    const statements: Sql[] = [];

    if (hasTextIndex(old)) statements.push(dropTextIndex(this.check.schemas, this.before.table, old.column));

    if (hasPolicyIndex(this.before, old))
      statements.push(dropPolicyIndex(this.check.schemas, this.before.table, old.column));

    if (old.column !== target.column) {
      statements.push({
        text: `ALTER TABLE ${this.table} RENAME COLUMN ${quoteName(old.column)} TO ${quoteName(target.column)}`,
        values: [],
      });
    }

    const storedRules = [...this.moveRequired(old, target, statements), ...this.valueTypeRules(old, target)];

    if (hasTextIndex(target)) statements.push(createTextIndex(this.check.schemas, this.after.table, target.column));

    statements.push(...createPolicyIndex(this.check.schemas, this.after, target));

    this.check.plan.replace(
      `Delete Property ${old.apiName} ${this.of}`,
      `Create Property ${target.apiName} ${this.of}`,
      {
        description: change,
        statements,
        table: this.storedTable,
        migration: move,
        ...(storedRules.length > 0 ? { storedRules } : {}),
      },
    );

    this.moved.set(old.apiName, target.apiName);
  }

  private moveRequired(old: CompiledProperty, target: CompiledProperty, statements: Sql[]): StoredRule[] {
    const required = isRequired(target, this.after);

    if (required === isRequired(old, this.before)) return [];

    const rule = required ? 'SET NOT NULL' : 'DROP NOT NULL';

    const statement: Sql = {
      text: `ALTER TABLE ${this.table} ALTER COLUMN ${quoteName(target.column)} ${rule}`,
      values: [],
    };

    statements.push(statement);

    return required ? this.required(old) : [];
  }

  private async *deleteProperty(old: CompiledProperty): AsyncFallible<void, CheckFailure> {
    const change = `Delete Property ${old.apiName} ${this.of}`;

    if (old.status.type === 'active') return yield activeStatus(change);

    const canMove = this.newProperties.some((p) => sameType(old.type, p.type));

    yield* this.check.require(
      change,
      this.dropOf(old.apiName),
      () => this.holdsValues(old),
      canMove ? ['dropProperty', 'renameProperty'] : ['dropProperty'],
    );
  }

  private *derivedProperties(): Fallible<void, ApiError> {
    for (const old of this.before.derived.values()) {
      if (old.status.type !== 'active') continue;

      const next = this.after.derived.get(old.apiName);

      if (!next) return yield activeStatus(`Delete Property ${old.apiName} ${this.of}`);

      if (!sameType(old.type, next.type))
        return yield activeStatus(`Change the base type of Property ${old.apiName} ${this.of}`);
    }
  }

  private async *properties(): AsyncFallible<void, CheckFailure> {
    for (const property of this.after.properties.values()) {
      if (!this.isMoveTarget(property.apiName)) yield* this.property(property);
    }
  }

  private async *property(property: CompiledProperty): AsyncFallible<void, CheckFailure> {
    const old = this.before.properties.get(property.apiName);

    if (!old) {
      if (isRequired(property, this.after))
        this.addRules(`Create Property ${property.apiName} ${this.of}`, this.required(property, true));
    } else if (isNewColumn(this.before, property)) {
      yield* this.baseTypeChange(old, property);
    } else {
      yield* this.structFields(old, property);

      const madeRequired = `Make Property ${property.apiName} required ${this.of}`;

      if (this.check.plan.has(madeRequired)) this.addRules(madeRequired, this.required(old));

      const valueType = valueTypeChange(old, property, this.name);

      if (valueType) this.addRules(valueType.description, this.valueTypeRules(old, property, valueType));
    }
  }

  private async *baseTypeChange(old: CompiledProperty, property: CompiledProperty): AsyncFallible<void, CheckFailure> {
    const change = `Change the base type of Property ${property.apiName} ${this.of}`;

    if (old.status.type === 'active') return yield activeStatus(change);

    const drop = this.dropOf(property.apiName);

    if (!drop && (yield* this.holdsValues(old))) return yield needsMigration(change, ['dropProperty']);

    if (isRequired(property, this.after)) this.addRules(change, this.required(property, true));

    if (drop) this.check.plan.use(change, drop);
  }

  private async *structFields(old: CompiledProperty, property: CompiledProperty): AsyncFallible<void, CheckFailure> {
    if (old.type.kind !== 'struct' || property.type.kind !== 'struct') return;

    for (const [field, type] of old.type.fields) {
      const next = property.type.fields.get(field);

      if (!next || !sameType(next, type)) yield* this.structField(old, property, field, next !== undefined);
    }
  }

  private async *structField(
    old: CompiledProperty,
    property: CompiledProperty,
    field: string,
    kept: boolean,
  ): AsyncFallible<void, CheckFailure> {
    const change = kept
      ? `Change the base type of struct field ${field} of Property ${property.apiName} ${this.of}`
      : `Delete struct field ${field} of Property ${property.apiName} ${this.of}`;

    const drop = this.dropOf(property.apiName);

    if (!drop && (yield* this.fieldHoldsValues(old, field))) return yield needsMigration(change, ['dropProperty']);

    this.check.plan.add({
      description: change,
      statements: drop ? [this.emptyStruct(old.column)] : [],
      table: this.storedTable,
      ...(drop ? { migration: drop } : {}),
    });
  }

  private emptyStruct(column: string): Sql {
    const name = quoteName(column);

    return {
      text: `UPDATE ${this.table} SET ${quoteName(VERSION_COLUMN)} = ${WRITE_VERSION}, ${name} = '{}'::jsonb WHERE ${name} IS DISTINCT FROM '{}'::jsonb`,
      values: [],
    };
  }

  private async *primaryKey(): AsyncFallible<void, DbFailure> {
    const { plan } = this.check;
    const statements = [...(yield* this.dropKeyConstraint()), this.addKeyConstraint()];

    plan.add({
      description: `Change the primary key ${this.of}`,
      statements,
      table: this.storedTable,
      ...(this.keyDrop ? { migration: this.keyDrop } : {}),
    });

    plan.moveToEnd(`Make Property ${this.before.primaryKey.apiName} optional ${this.of}`);

    if (this.keyDrop) plan.prepend(this.storedTable, { text: `DELETE FROM ${this.table}`, values: [] });
  }

  private async *dropKeyConstraint(): AsyncFallible<Sql[], DbFailure> {
    const constraint = yield* this.check.stored.primaryKeyName(this.before.table);

    return constraint
      ? [{ text: `ALTER TABLE ${this.table} DROP CONSTRAINT IF EXISTS ${quoteName(constraint)}`, values: [] }]
      : [];
  }

  private addKeyConstraint(): Sql {
    return {
      text: `ALTER TABLE ${this.table} ADD ${primaryKeyConstraint(this.before.table, [this.after.primaryKey.column])}`,
      values: [],
    };
  }

  private async *editHistoryOff(): AsyncFallible<void, CheckFailure> {
    const drop = this.check.find('dropEditHistory', (m) => m.objectType === this.name);

    yield* this.check.require(
      `Turn off Object Edit History ${this.of}`,
      drop,
      () => this.check.stored.hasHistory(this.name),
      ['dropEditHistory'],
    );
  }
}

export async function* useSchemaMigrations(
  db: Db,
  schemas: Schemas,
  ontology: CompiledOntology,
  current: CompiledOntology | undefined,
  planned: readonly Change[],
  migrations: readonly SchemaMigration[],
  options: { readonly standIns: boolean; readonly hasStoredValues: boolean },
): AsyncFallible<Change[], CheckFailure> {
  if (!current) return [...planned];

  const check = new Check(db, schemas, planned, migrations, options.hasStoredValues);

  for (const before of current.objectTypes.values()) {
    const after = ontology.objectTypes.get(before.apiName);

    if (after) {
      yield* checkLinkSides(before, after, current, ontology);

      yield* new ObjectTypeCheck(check, before, after).run();
    } else yield* check.deletedObjectType(before);
  }

  for (const link of current.linkTypes.values()) yield* check.deletedLinkType(link, ontology);

  for (const before of current.actionTypes.values())
    yield* checkActionType(before, ontology.actionTypes.get(before.apiName), options.standIns);

  return check.plan.changes;
}
