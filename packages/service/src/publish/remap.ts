import { REGISTRY_SCHEMA, type Db, type DbFailure } from '../db/index.ts';
import { settle, type AsyncFallible } from '../errors/index.ts';
import { lockProductVersions } from './install.ts';
import { limitKind } from './pure/versionLimits.ts';

const ONTOLOGIES = `${REGISTRY_SCHEMA}.ontologies`;
const REMAP_LOCK_TIMEOUT = '90s';

interface Remapped {
  readonly ontologyRid: string;
  readonly apiName: string;
  readonly from: string;
  readonly to: string;
}

interface Clash {
  readonly ontologyRid: string;
  readonly apiName: string;
  readonly organization: string;
  readonly mirror: string;
}

export interface RemapInput {
  readonly mirrors: ReadonlyMap<string, string>;
  readonly branchId: string;
  readonly lockTimeout?: string | undefined;
}

export type RemapOutcome =
  | { readonly kind: 'remapped'; readonly remapped: readonly Remapped[]; readonly clashes: readonly Clash[] }
  | {
      readonly kind: 'refused';
      readonly errorName: 'WrongBranch';
      readonly setting: string | null;
      readonly branchId: string;
    }
  | { readonly kind: 'refused'; readonly errorName: 'PublishLockTimeout' };

export async function* readOwners(db: Db): AsyncFallible<string[], DbFailure> {
  const rows = yield* db.query<{ organization: string }>({
    text: `SELECT DISTINCT organization FROM ${ONTOLOGIES} WHERE organization IS NOT NULL AND organization <> '' ORDER BY organization`,
    values: [],
  });

  return rows.map((row) => row.organization);
}

export async function* remap(directDb: Db, input: RemapInput): AsyncFallible<RemapOutcome, DbFailure> {
  const ran = await settle(
    directDb.transaction(async function* (tx): AsyncFallible<RemapOutcome, DbFailure> {
      yield* tx.query({
        text: "SELECT set_config('lock_timeout', $1, true)",
        values: [input.lockTimeout ?? REMAP_LOCK_TIMEOUT],
      });

      yield* tx.query({ text: "SELECT set_config('statement_timeout', '120s', true)", values: [] });

      const [setting] = yield* tx.query<{ branch: string | null }>({
        text: "SELECT current_setting('neon.branch_id', true) AS branch",
        values: [],
      });

      const branch = setting?.branch ?? null;

      if (branch === null || branch === '' || branch !== input.branchId) {
        return { kind: 'refused', errorName: 'WrongBranch', setting: branch, branchId: input.branchId };
      }

      yield* lockProductVersions(tx);

      return yield* remapRows(tx, input.mirrors);
    }),
  );

  if (ran.ok) return ran.value;

  if (limitKind(ran.error.error) === 'lock') return { kind: 'refused', errorName: 'PublishLockTimeout' };

  return yield ran.error;
}

async function* remapRows(tx: Db, mirrors: ReadonlyMap<string, string>): AsyncFallible<RemapOutcome, DbFailure> {
  const rows = yield* tx.query<{ number: number; rid: string; api_name: string; organization: string | null }>({
    text: `SELECT number, rid, api_name, organization FROM ${ONTOLOGIES} ORDER BY number`,
    values: [],
  });

  const remapped: Remapped[] = [];
  const clashes: Clash[] = [];

  for (const row of rows) {
    if (!row.organization) continue;

    const mirror = mirrors.get(row.organization);

    if (mirror === undefined) continue;

    const moved = yield* tx.query({
      text: `UPDATE ${ONTOLOGIES} SET organization = $2 WHERE number = $1
             AND NOT EXISTS (SELECT 1 FROM ${ONTOLOGIES} WHERE organization = $2 AND api_name = $3)
             RETURNING number`,
      values: [row.number, mirror, row.api_name],
    });

    if (moved.length > 0)
      remapped.push({ ontologyRid: row.rid, apiName: row.api_name, from: row.organization, to: mirror });
    else clashes.push({ ontologyRid: row.rid, apiName: row.api_name, organization: row.organization, mirror });
  }

  return { kind: 'remapped', remapped, clashes };
}
