import { ontologyEngineChanges, REGISTRY_SCHEMA, type Db, type DbFailure, type Schemas } from '../../db/index.ts';
import type { AsyncFallible } from '../../errors/index.ts';
import { readNewestNumber } from '../versions.ts';
import { liveEngineDifferences, readRow, switchRefusal, type RestoreRow } from './restoreChecks.ts';

export type { RestoreRow } from './restoreChecks.ts';

const ONTOLOGIES = `${REGISTRY_SCHEMA}.ontologies`;

const ONTOLOGY_CHANGES = ontologyEngineChanges({ object: '', engine: '' }).length;

export interface RestorePlan {
  readonly live: RestoreRow;
  readonly source: RestoreRow;
  readonly schemas: Schemas;
  readonly engineChangeCount: number;
  readonly newestVersion: number;
  readonly orphans: readonly string[];
}

export function stampOf(start: Date): string {
  return start.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function restoredSchemas(number: number, stamp: string): Schemas {
  return { object: `ontology_${number}_objects_${stamp}`, engine: `ontology_${number}_engine_${stamp}` };
}

function sourceEngineDifferences(sourceCount: number): string[] {
  return sourceCount <= ONTOLOGY_CHANGES
    ? []
    : [
        `The source row has ${sourceCount} per-Ontology engine changes, above the ${ONTOLOGY_CHANGES} of this checkout.`,
      ];
}

export async function* planRestore(
  directDb: Db,
  sourceDb: Db,
  rid: string,
  stamp: string,
): AsyncFallible<RestorePlan | string, DbFailure> {
  const live = yield* readRow(directDb, rid);

  if (!live) return `No installation has the RID ${rid} in production.`;

  const source = yield* readRow(sourceDb, rid);

  if (!source) return `No installation has the RID ${rid} in the source branch.`;

  const differences = [
    ...(yield* liveEngineDifferences(directDb, live.engineChangeCount)),
    ...sourceEngineDifferences(source.engineChangeCount),
  ];

  if (differences.length > 0) return `The engine changes differ from this checkout. ${differences.join(' ')}`;

  const refusal = yield* switchRefusal(directDb, live, source);

  if (refusal) return refusal;

  const schemas = restoredSchemas(live.number, stamp);

  const named = yield* directDb.query<{ name: string }>({
    text: `SELECT n.nspname AS name FROM pg_namespace n
           WHERE n.nspname = ANY($1::text[]) AND EXISTS (SELECT 1 FROM ${ONTOLOGIES} o WHERE n.nspname IN (o.object_schema, o.engine_schema))
           ORDER BY n.nspname COLLATE "C"`,
    values: [[schemas.object, schemas.engine]],
  });

  if (named.length > 0)
    return `A registry row names the new schema ${named.map((row) => row.name).join(' and ')}, so the copy writes nothing.`;

  const orphans = yield* directDb.query<{ name: string }>({
    text: `SELECT n.nspname AS name FROM pg_namespace n
           WHERE n.nspname ~ $1 AND NOT EXISTS (SELECT 1 FROM ${ONTOLOGIES} o WHERE n.nspname IN (o.object_schema, o.engine_schema))
           ORDER BY n.nspname COLLATE "C"`,
    values: [`^ontology_${live.number}_(objects|engine)_[0-9]{14}$`],
  });

  const newestVersion = yield* readNewestNumber(directDb, live.product);

  return {
    live,
    source,
    schemas,
    engineChangeCount: ONTOLOGY_CHANGES,
    newestVersion,
    orphans: orphans.map((row) => row.name),
  };
}
