import type { Db, DbFailure, Schemas } from '../db/index.ts';
import { ApiError, type AsyncFallible, type Fallible } from '../errors/index.ts';
import type { CompiledOntology } from '../ontology/index.ts';
import type { Change } from './plan.ts';
import { isNewColumn } from './schema/tableSql.ts';

const MAX_COLUMNS = 1_600;

export async function* readUsedColumns(db: Db, schemas: Schemas): AsyncFallible<Map<string, number>, DbFailure> {
  const rows = yield* db.query<{ table: string; columns: number }>({
    text: `SELECT c.relname AS table, count(*)::int AS columns
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relkind = 'r' AND a.attnum > 0
           GROUP BY c.relname`,
    values: [schemas.object],
  });

  return new Map(rows.map((row) => [row.table, row.columns]));
}

export function* checkColumnLimit(
  ontology: CompiledOntology,
  current: CompiledOntology | undefined,
  changes: readonly Change[],
  used: ReadonlyMap<string, number>,
): Fallible<void, ApiError> {
  const moveTargets = new Set(
    changes.flatMap(({ migration: m }) => (m?.type === 'renameProperty' ? [`${m.objectType}:${m.target}`] : [])),
  );

  for (const type of ontology.objectTypes.values()) {
    const before = current?.objectTypes.get(type.apiName);
    const properties = [...type.properties.values()];

    const added = (property: (typeof properties)[number]) =>
      isNewColumn(before, property) && !moveTargets.has(`${type.apiName}:${property.apiName}`);

    const columns = before ? (used.get(type.table) ?? 0) + properties.filter(added).length : properties.length + 1;

    if (columns > MAX_COLUMNS) {
      return yield new ApiError(400, 'Default:InvalidArgument', {
        objectType: type.apiName,
        columns,
        maxColumns: MAX_COLUMNS,
      });
    }
  }
}
