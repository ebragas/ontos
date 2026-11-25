import type { Db, DbFailure } from '../../db/index.ts';
import type { ApiError, AsyncFallible, Fault } from '../../errors/index.ts';
import { parseGrantsFile, type GrantsFile } from '../../ontology/index.ts';
import { PRODUCT_VERSIONS } from '../versions.ts';
import { planReconcile } from '../workosSteps.ts';
import type { RoleSlug, WorkosPort } from './types.ts';

export interface StoredGrants {
  readonly newest: GrantsFile | undefined;
  readonly roles: ReadonlySet<RoleSlug>;
}

export async function* readStoredGrants(db: Db, product: string): AsyncFallible<StoredGrants, DbFailure> {
  const rows = yield* db.query<{ grants: unknown }>({
    text: `SELECT grants FROM ${PRODUCT_VERSIONS} WHERE product = $1 ORDER BY version`,
    values: [product],
  });

  const files = rows.map((row) => grantsOf(row.grants));
  const newest = files.at(-1);

  return { newest, roles: new Set(newest ? files.flatMap((grants) => Object.keys(grants?.defaultRoles ?? {})) : []) };
}

export async function* reconcile(
  db: Db,
  product: string,
  port: WorkosPort,
): AsyncFallible<void, ApiError | DbFailure | Fault> {
  const { newest, roles } = yield* readStoredGrants(db, product);

  if (!newest) return;

  const read = yield* port.read();

  for (const { role, permissions, create } of planReconcile(newest, roles, read)) {
    if (create) yield* port.apply({ step: 'createRole', role });

    yield* port.setPermissions(role, permissions);
  }
}

function grantsOf(value: unknown): GrantsFile | undefined {
  const parsed = parseGrantsFile(value);

  return 'grants' in parsed ? parsed.grants : undefined;
}
