import { createDb, createPool, type Db, type DbFailure } from '../db/index.ts';
import { attempt, caught, settle, type AsyncFallible } from '../errors/index.ts';
import { readOwners, remap, type RemapInput, type RemapOutcome } from './remap.ts';

const VARIABLES = ['DATABASE_URL_DIRECT', 'WORKOS_API_KEY', 'NEON_BRANCH_ID'] as const;
const WORKOS = 'https://api.workos.com';

export interface EntryIo extends Pick<RemapInput, 'lockTimeout'> {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface Refusal {
  readonly kind: 'line';
  readonly line: string;
}

const refusal = (line: string): Refusal => ({ kind: 'line', line });

export async function main(io: EntryIo): Promise<number> {
  const missing = VARIABLES.filter((name) => !io.env[name]);
  const [url, key, branchId] = VARIABLES.map((name) => io.env[name] ?? '');

  if (missing.length > 0 || !url || !key || !branchId) {
    io.stderr(
      `The remap entry reads ${VARIABLES.slice(0, -1).join(', ')}, and ${VARIABLES.at(-1)} from the environment. Missing: ${missing.join(', ')}.\n`,
    );

    return 1;
  }

  const ran = await caught(() => settle(remapAll(io, url, key, branchId)));

  if (!ran.ok) return fail(io, databaseLine(ran.error));

  if (!ran.value.ok)
    return fail(io, ran.value.error.kind === 'line' ? ran.value.error.line : databaseLine(ran.value.error.error));

  const outcome = ran.value.value;

  const wrote = caught(() => {
    if (outcome.kind === 'refused') io.stderr(`${refusalLine(outcome)}\n`);
    else io.stdout(`${JSON.stringify({ remapped: outcome.remapped, clashes: outcome.clashes })}\n`);
  });

  if (!wrote.ok) return fail(io, databaseLine(wrote.error));

  return outcome.kind === 'refused' || outcome.clashes.length > 0 ? 1 : 0;
}

function fail(io: EntryIo, line: string): number {
  io.stderr(`${line}\n`);

  return 1;
}

const databaseLine = (error: unknown): string =>
  `The remap failed with the database error ${codeOf(error)}. Its result is not known, and a repeat is safe.`;

async function* remapAll(
  io: EntryIo,
  url: string,
  key: string,
  branchId: string,
): AsyncFallible<RemapOutcome, DbFailure | Refusal> {
  const owners = yield* withDb(url, readOwners);
  const mirrors = new Map<string, string>();

  for (const owner of owners) {
    const mirror = yield* mirrorOf(io.fetch, key, owner);

    if (mirror !== undefined) mirrors.set(owner, mirror);
  }

  return yield* withDb(url, (db) => remap(db, { mirrors, branchId, lockTimeout: io.lockTimeout }));
}

async function* withDb<T>(url: string, run: (db: Db) => AsyncFallible<T, DbFailure>): AsyncFallible<T, DbFailure> {
  const pool = createPool(url, { max: 1 });

  try {
    return yield* run(createDb(pool));
  } finally {
    await caught(() => pool.end());
  }
}

function refusalLine(outcome: Extract<RemapOutcome, { kind: 'refused' }>): string {
  if (outcome.errorName === 'PublishLockTimeout')
    return 'PublishLockTimeout: the wait for the lock of install ended. The remap changed nothing, and a repeat is safe.';

  if (!outcome.setting)
    return `The connection has no Neon branch (no neon.branch_id), not the branch staging ${outcome.branchId}. The remap changed nothing.`;

  return `The connection is to the Neon branch ${outcome.setting}, not to the branch staging ${outcome.branchId}. The remap changed nothing.`;
}

async function* mirrorOf(
  fetch: typeof globalThis.fetch,
  key: string,
  owner: string,
): AsyncFallible<string | undefined, Refusal> {
  const response = yield* attempt(
    () =>
      fetch(`${WORKOS}/organizations/external_id/${encodeURIComponent(owner)}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}` },
      }),
    (error) =>
      refusal(
        `WorkOS could not be reached for the owner ${owner} (${codeOf((error as { cause?: unknown } | null)?.cause ?? error)}). The remap changed nothing.`,
      ),
  );

  if (response.status === 404) return undefined;

  const body =
    response.status === 200 ? await caught(() => response.json() as Promise<{ id?: unknown } | null>) : undefined;

  const id = body?.ok ? body.value?.id : undefined;

  if (typeof id !== 'string' || id === '')
    return yield refusal(
      `WorkOS answered ${response.status} for the owner ${owner}, with no Mirror Organization ID. The remap changed nothing.`,
    );

  return id;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;

  if (typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code)) return code;

  return error instanceof Error ? error.name : 'with no code';
}

// D1: D1 (2026-11-20): the Node process border of a child-process entry; a stderr write that throws must reject main, as on staging.
if (import.meta.main)
  process.exitCode = await main({
    env: process.env,
    fetch,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
