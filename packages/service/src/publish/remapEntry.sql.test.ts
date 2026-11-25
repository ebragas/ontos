import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, type EntryIo } from './remapEntry.ts';
import { onNewConnection } from './publish.test-utils.ts';
import { createEngineTemplate, startPostgres, type TestPostgres } from '../postgres.test-utils.ts';

const ENTRY = new URL('./remapEntry.ts', import.meta.url).pathname;
const SERVICE = new URL('../../', import.meta.url).pathname;
const ONTOLOGIES = 'ontology_registry.ontologies';
const BRANCH = 'br-staging-0001';
const WORKOS_KEY = 'sk_test_remap0entry0key0never0printed';
const ACME = 'org_ACME';
const BOLT = 'org_BOLT';
const ACME_MIRROR = 'org_ACME_MIRROR';
const SERVICE_PASSWORD = 'remap-entry-role-test-only';
const MARKER = 'marker0password0never0printed';

let postgres: TestPostgres;
let control: pg.Client;
let serviceRole: string;
let template: string;
let databases = 0;

const openAdmins = new Set<pg.Client>();

interface TestDatabase {
  readonly name: string;
  readonly admin: pg.Client;
  readonly url: string;
}

let database: TestDatabase;

async function closeAdmin(client: pg.Client | undefined): Promise<void> {
  if (!client || !openAdmins.delete(client)) return;

  await client.end().catch(() => undefined);
}

beforeAll(async () => {
  postgres = await startPostgres();

  serviceRole = `${postgres.role}_service`;

  await onNewConnection(
    postgres.url,
    `CREATE ROLE ${serviceRole} LOGIN PASSWORD '${SERVICE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );

  template = await createEngineTemplate(postgres.url, { name: serviceRole, password: SERVICE_PASSWORD });

  control = new pg.Client({ connectionString: postgres.url });

  control.on('error', () => undefined);

  await control.connect();
});

afterAll(async () => {
  await Promise.all([...openAdmins].map((client) => closeAdmin(client)));

  await control?.end().catch(() => undefined);

  await postgres?.stop();
});

beforeEach(async () => {
  database = await newDatabase(BRANCH);
});

afterEach(async () => {
  await closeAdmin(database?.admin);
});

async function newDatabase(branch: string | undefined): Promise<TestDatabase> {
  const name = `${postgres.role}_remap_entry_${++databases}`;

  await control.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);

  await control.query(`GRANT CREATE ON DATABASE ${name} TO ${serviceRole}`);

  if (branch !== undefined) await control.query(`ALTER DATABASE ${name} SET neon.branch_id = '${branch}'`);

  const url = new URL(postgres.url);

  url.pathname = `/${name}`;

  const admin = new pg.Client({ connectionString: url.toString() });

  admin.on('error', () => undefined);

  await admin.connect();

  openAdmins.add(admin);

  url.username = serviceRole;
  url.password = SERVICE_PASSWORD;

  return { name, admin, url: url.toString() };
}

async function row(
  on: TestDatabase,
  apiName: string,
  organization: string | null,
  rid = `ri.ontology.main.ontology.${crypto.randomUUID()}`,
): Promise<string> {
  await on.admin.query(
    `INSERT INTO ${ONTOLOGIES} (rid, api_name, display_name, object_schema, engine_schema, product, version, organization, engine_change_count)
     VALUES ($1, $2, 'The ' || $2 || ' display name', 'ontology_0_objects', 'ontology_0_engine', 'twin', 1, $3, 0)`,
    [rid, apiName, organization],
  );

  return rid;
}

async function registry(on: TestDatabase = database): Promise<Record<string, unknown>[]> {
  return (await on.admin.query(`SELECT * FROM ${ONTOLOGIES} ORDER BY number`)).rows;
}

async function waitForNoOpenSession(on: TestDatabase, role: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const { rows } = await on.admin.query<{ open: number }>(
          'SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname = $1 AND usename = $2',
          [on.name, role],
        );

        return rows[0]?.open ?? -1;
      },
      { timeout: 1_000, interval: 25 },
    )
    .toBe(0);
}

async function sessions(on: TestDatabase): Promise<number> {
  await on.admin.query('SELECT pg_stat_clear_snapshot()');

  const { rows } = await on.admin.query<{ sessions: number }>(
    'SELECT sessions::int FROM pg_stat_database WHERE datname = $1',
    [on.name],
  );

  return rows[0]?.sessions ?? -1;
}

interface Call {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
}

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

function workos(answers: Readonly<Record<string, string | number>>): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];

  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);

    calls.push({ method: init?.method ?? 'GET', url, authorization: new Headers(init?.headers).get('authorization') });

    const owner = decodeURIComponent(url.split('/').at(-1) ?? '');
    const answer = answers[owner] ?? 404;

    if (typeof answer === 'number')
      return new Response(answer === 204 ? null : JSON.stringify({ message: 'stub', id: 'org_NOT_A_MIRROR' }), {
        status: answer,
      });

    return Response.json({ object: 'organization', id: answer, external_id: owner });
  }) as typeof fetch & { calls: Call[] };

  stub.calls = calls;

  return stub;
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const ENV = () => ({ DATABASE_URL_DIRECT: database.url, WORKOS_API_KEY: WORKOS_KEY, NEON_BRANCH_ID: BRANCH });

async function run(
  fetch: typeof globalThis.fetch,
  env: Readonly<Record<string, string | undefined>> = ENV(),
  extra: Partial<EntryIo> = {},
): Promise<Run> {
  let stdout = '';
  let stderr = '';

  const code = await main({
    env,
    fetch,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    ...extra,
  });

  return { code, stdout, stderr };
}

const lines = (text: string): string[] => text.split('\n').filter(Boolean);

describe('the variables', () => {
  it.each([
    [['DATABASE_URL_DIRECT'], 'DATABASE_URL_DIRECT'],
    [['WORKOS_API_KEY'], 'WORKOS_API_KEY'],
    [['NEON_BRANCH_ID'], 'NEON_BRANCH_ID'],
    [
      ['DATABASE_URL_DIRECT', 'WORKOS_API_KEY', 'NEON_BRANCH_ID'],
      'DATABASE_URL_DIRECT, WORKOS_API_KEY, NEON_BRANCH_ID',
    ],
  ])(
    'service/storage#remap: with %j missing, the entry exits 1 before any call, and its 1 error line names each one',
    async (missing, named) => {
      await row(database, 'alpha', ACME);

      const before = await registry();

      const fetch = workos({ [ACME]: ACME_MIRROR });

      const env = Object.fromEntries(
        Object.entries(ENV()).map(([name, value]) => [name, missing.includes(name) ? undefined : value]),
      );

      const connects = vi.spyOn(pg.Client.prototype, 'connect');
      let result: Run;

      try {
        result = await run(fetch, env);

        expect(connects).not.toHaveBeenCalled();
      } finally {
        connects.mockRestore();
      }

      expect(result).toEqual({
        code: 1,
        stdout: '',
        stderr: `The remap entry reads DATABASE_URL_DIRECT, WORKOS_API_KEY, and NEON_BRANCH_ID from the environment. Missing: ${named}.\n`,
      });

      expect(fetch.calls).toEqual([]);

      expect(await registry()).toEqual(before);
    },
  );
});

describe('the WorkOS reads', () => {
  it('service/storage#remap: 2 owners and 1 row with no owner give exactly 2 GETs of the external ID, each with the key, and a 404 means no Mirror Organization', async () => {
    const acme = await row(database, 'alpha', ACME);

    await row(database, 'beta', ACME);

    await row(database, 'gamma', BOLT);

    await row(database, 'delta', null);

    const fetch = workos({ [ACME]: ACME_MIRROR, [BOLT]: 404 });

    const result = await run(fetch);

    expect(fetch.calls).toEqual([
      {
        method: 'GET',
        url: `https://api.workos.com/organizations/external_id/${ACME}`,
        authorization: `Bearer ${WORKOS_KEY}`,
      },
      {
        method: 'GET',
        url: `https://api.workos.com/organizations/external_id/${BOLT}`,
        authorization: `Bearer ${WORKOS_KEY}`,
      },
    ]);

    expect(result.code).toBe(0);

    expect(JSON.parse(result.stdout).remapped[0]).toEqual({
      ontologyRid: acme,
      apiName: 'alpha',
      from: ACME,
      to: ACME_MIRROR,
    });

    expect((await registry()).map((r) => r['organization'])).toEqual([ACME_MIRROR, ACME_MIRROR, BOLT, null]);
  });

  it('service/storage#remap: an owner ID with a slash is 1 path segment of the GET', async () => {
    await row(database, 'alpha', 'org/odd');

    const fetch = workos({});

    expect((await run(fetch)).code).toBe(0);

    expect(fetch.calls.map((call) => call.url)).toEqual(['https://api.workos.com/organizations/external_id/org%2Fodd']);
  });

  it.each([500, 401, 429, 201, 204, 299, 200])(
    'service/storage#remap: a WorkOS answer %i that gives no Mirror Organization exits 1 before the transaction, names the owner and the status, and changes no row',
    async (status) => {
      await row(database, 'alpha', ACME);

      await row(database, 'beta', BOLT);

      const before = await registry();

      const stub = workos({ [ACME]: ACME_MIRROR, [BOLT]: status });

      const fetch = (
        status === 200
          ? async (input: string | URL | Request, init?: RequestInit) => {
              if (urlOf(input).endsWith(BOLT)) return Response.json({ object: 'organization' });

              return stub(input, init);
            }
          : stub
      ) as typeof globalThis.fetch;

      const result = await run(fetch);

      expect(result).toEqual({
        code: 1,
        stdout: '',
        stderr: `WorkOS answered ${status} for the owner ${BOLT}, with no Mirror Organization ID. The remap changed nothing.\n`,
      });

      expect(await registry()).toEqual(before);
    },
  );

  it('service/storage#remap: a 200 answer with an empty id exits 1, and no row gets the owner ""', async () => {
    await row(database, 'alpha', ACME);

    const before = await registry();

    const fetch = (async () => Response.json({ object: 'organization', id: '' })) as typeof globalThis.fetch;

    expect(await run(fetch)).toEqual({
      code: 1,
      stdout: '',
      stderr: `WorkOS answered 200 for the owner ${ACME}, with no Mirror Organization ID. The remap changed nothing.\n`,
    });

    expect(await registry()).toEqual(before);
  });

  it('service/storage#remap: a fetch error with no code prints only its name, never its message', async () => {
    await row(database, 'alpha', ACME);

    const fetch = (async () => {
      throw new TypeError(`marker0message0never0printed ${WORKOS_KEY}`);
    }) as typeof globalThis.fetch;

    expect(await run(fetch)).toEqual({
      code: 1,
      stdout: '',
      stderr: `WorkOS could not be reached for the owner ${ACME} (TypeError). The remap changed nothing.\n`,
    });
  });

  it('service/storage#remap: the entry holds no idle connection during the WorkOS reads, so a connection that ends there prints nothing', async () => {
    await row(database, 'alpha', ACME);

    const consoleError = vi.spyOn(console, 'error');

    try {
      const stub = workos({ [ACME]: ACME_MIRROR });
      let fetchCalls = 0;

      const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        fetchCalls += 1;

        await waitForNoOpenSession(database, serviceRole);

        const { rows: terminated } = await database.admin.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND usename = $2',
          [database.name, serviceRole],
        );

        if (terminated.length > 0) await new Promise((resolve) => setTimeout(resolve, 200));

        return stub(input, init);
      }) as typeof globalThis.fetch;

      const result = await run(fetch);

      expect(fetchCalls).toBe(1);
      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('service/storage#remap: a fetch that throws exits 1 with 1 fixed line that names the owner and holds no key', async () => {
    await row(database, 'alpha', ACME);

    const before = await registry();

    const fetch = (async () => {
      throw Object.assign(new TypeError(`fetch failed for Bearer ${WORKOS_KEY}`), { cause: { code: 'ECONNRESET' } });
    }) as typeof globalThis.fetch;

    const result = await run(fetch);

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: `WorkOS could not be reached for the owner ${ACME} (ECONNRESET). The remap changed nothing.\n`,
    });

    expect(await registry()).toEqual(before);
  });
});

describe('the output', () => {
  it('service/storage#remap: with no clash, the entry prints 1 JSON object with remapped and clashes in the order of the registry number, and exits 0', async () => {
    const first = await row(database, 'alpha', ACME);

    await row(database, 'beta', BOLT);

    const second = await row(database, 'gamma', ACME);

    const result = await run(workos({ [ACME]: ACME_MIRROR }));

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(lines(result.stdout)).toHaveLength(1);

    expect(JSON.parse(result.stdout)).toEqual({
      remapped: [
        { ontologyRid: first, apiName: 'alpha', from: ACME, to: ACME_MIRROR },
        { ontologyRid: second, apiName: 'gamma', from: ACME, to: ACME_MIRROR },
      ],
      clashes: [],
    });
  });

  it('service/storage#remap: with a clash, the entry prints both lists, commits the other rows, and exits 1', async () => {
    const clash = await row(database, 'alpha', ACME);

    const moved = await row(database, 'beta', ACME);

    await row(database, 'alpha', ACME_MIRROR);

    const result = await run(workos({ [ACME]: ACME_MIRROR }));

    expect(result.code).toBe(1);

    expect(JSON.parse(result.stdout)).toEqual({
      remapped: [{ ontologyRid: moved, apiName: 'beta', from: ACME, to: ACME_MIRROR }],
      clashes: [{ ontologyRid: clash, apiName: 'alpha', organization: ACME, mirror: ACME_MIRROR }],
    });

    expect((await registry()).map((r) => r['organization'])).toEqual([ACME, ACME_MIRROR, ACME_MIRROR]);
  });

  it('service/storage#remap: with no row, the entry sends no GET, prints empty lists, and exits 0', async () => {
    const fetch = workos({});

    expect(await run(fetch)).toEqual({
      code: 0,
      stdout: `${JSON.stringify({ remapped: [], clashes: [] })}\n`,
      stderr: '',
    });

    expect(fetch.calls).toEqual([]);
  });

  it('service/storage#remap: a second run of the entry changes no row and exits 0', async () => {
    await row(database, 'alpha', ACME);

    expect((await run(workos({ [ACME]: ACME_MIRROR }))).code).toBe(0);

    const before = await registry();

    expect(await run(workos({ [ACME]: ACME_MIRROR }))).toEqual({
      code: 0,
      stdout: `${JSON.stringify({ remapped: [], clashes: [] })}\n`,
      stderr: '',
    });

    expect(await registry()).toEqual(before);
  });
});

describe('the branch guard', () => {
  it('service/storage#remap: a NEON_BRANCH_ID that differs from neon.branch_id exits 1 with 1 line on stderr, and changes no row', async () => {
    await row(database, 'alpha', ACME);

    const before = await registry();

    const result = await run(workos({ [ACME]: ACME_MIRROR }), { ...ENV(), NEON_BRANCH_ID: 'br-production-0002' });

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: `The connection is to the Neon branch ${BRANCH}, not to the branch staging br-production-0002. The remap changed nothing.\n`,
    });

    expect(await registry()).toEqual(before);
  });

  it('service/storage#remap: an empty neon.branch_id exits 1 with the line of no branch, and changes no row', async () => {
    const empty = await newDatabase('');

    try {
      await row(empty, 'alpha', ACME);

      const before = await registry(empty);

      const result = await run(workos({ [ACME]: ACME_MIRROR }), { ...ENV(), DATABASE_URL_DIRECT: empty.url });

      expect(result).toEqual({
        code: 1,
        stdout: '',
        stderr: `The connection has no Neon branch (no neon.branch_id), not the branch staging ${BRANCH}. The remap changed nothing.\n`,
      });

      expect(await registry(empty)).toEqual(before);
    } finally {
      await closeAdmin(empty.admin);
    }
  });

  it('service/storage#remap: a database with no neon.branch_id exits 1 with 1 line on stderr, and changes no row', async () => {
    const bare = await newDatabase(undefined);

    try {
      await row(bare, 'alpha', ACME);

      const before = await registry(bare);

      const result = await run(workos({ [ACME]: ACME_MIRROR }), { ...ENV(), DATABASE_URL_DIRECT: bare.url });

      expect(result).toEqual({
        code: 1,
        stdout: '',
        stderr: `The connection has no Neon branch (no neon.branch_id), not the branch staging ${BRANCH}. The remap changed nothing.\n`,
      });

      expect(await registry(bare)).toEqual(before);
    } finally {
      await closeAdmin(bare.admin);
    }
  });
});

describe('the lock wait', () => {
  it('service/storage#remap: when the wait for lockProductVersions ends, the entry exits 1 with 1 line on stderr with PublishLockTimeout, and changes no row', async () => {
    await row(database, 'alpha', ACME);

    const before = await registry();

    const holder = new pg.Client({ connectionString: new URL(`/${database.name}`, postgres.url).toString() });

    await holder.connect();

    try {
      await holder.query('BEGIN');

      await holder.query('LOCK TABLE ontology_registry.product_versions IN EXCLUSIVE MODE');

      const result = await run(workos({ [ACME]: ACME_MIRROR }), ENV(), { lockTimeout: '300ms' });

      expect(result).toEqual({
        code: 1,
        stdout: '',
        stderr:
          'PublishLockTimeout: the wait for the lock of install ended. The remap changed nothing, and a repeat is safe.\n',
      });

      expect(await registry()).toEqual(before);
    } finally {
      await holder.query('ROLLBACK');

      await holder.end();
    }
  });

  it('service/storage#remap: the entry passes no lock wait to main, so the remap uses the release value 90s', () => {
    const source = readFileSync(ENTRY, 'utf8');
    const last = source.trimEnd().split('\n');
    const d1Index = last.findLastIndex((line) => line.startsWith('// D1: '));

    expect(d1Index).toBeGreaterThan(-1);

    expect(last.slice(d1Index + 1).join('\n')).toBe(
      [
        'if (import.meta.main)',
        '  process.exitCode = await main({',
        '    env: process.env,',
        '    fetch,',
        '    stdout: (text) => process.stdout.write(text),',
        '    stderr: (text) => process.stderr.write(text),',
        '  });',
      ].join('\n'),
    );

    expect(
      source
        .split('\n')
        .filter((line) => line.includes('lockTimeout'))
        .map((line) => line.trim()),
    ).toEqual([
      "export interface EntryIo extends Pick<RemapInput, 'lockTimeout'> {",
      'return yield* withDb(url, (db) => remap(db, { mirrors, branchId, lockTimeout: io.lockTimeout }));',
    ]);
  });
});

describe('the connection', () => {
  it('service/storage#remap: a connection error prints 1 fixed line with its code, and no part of DATABASE_URL_DIRECT', async () => {
    const url = `postgresql://ontology_service:${MARKER}@127.0.0.1:1/neondb`;

    const result = await run(workos({}), { ...ENV(), DATABASE_URL_DIRECT: url });

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'The remap failed with the database error ECONNREFUSED. Its result is not known, and a repeat is safe.\n',
    });
  });

  it('service/storage#remap: a malformed DATABASE_URL_DIRECT prints 1 fixed line, and not its password', async () => {
    const result = await run(workos({}), {
      ...ENV(),
      DATABASE_URL_DIRECT: `postgresql://ontology_service:${MARKER}@[bad/neondb`,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(lines(result.stderr)).toHaveLength(1);

    expect(result.stderr).toMatch(
      /^The remap failed with the database error [A-Za-z_0-9]+\. Its result is not known, and a repeat is safe\.\n$/,
    );

    expect(result.stderr).not.toContain(MARKER);
  });

  describe('direct database selection', () => {
    let direct: TestDatabase;
    let other: TestDatabase;
    let stdout: string;
    let stderr: string;
    let usedBefore: number;
    let otherSessionsBefore: number;
    let otherBefore: Record<string, unknown>[];

    beforeAll(async () => {
      direct = await newDatabase(BRANCH);

      other = await newDatabase(BRANCH);

      const folder = mkdtempSync(join(tmpdir(), 'remap-entry-'));

      try {
        await row(direct, 'alpha', ACME);

        await row(other, 'alpha', ACME);

        otherBefore = await registry(other);

        [usedBefore, otherSessionsBefore] = [await sessions(direct), await sessions(other)];

        const preload = join(folder, 'workos.mjs');

        writeFileSync(
          preload,
          `globalThis.fetch = async (input) => String(input).endsWith('/${ACME}') ? Response.json({ id: '${ACME_MIRROR}' }) : new Response('{}', { status: 404 });\n`,
        );

        ({ stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['--import', preload, 'src/publish/remapEntry.ts'],
          {
            cwd: SERVICE,
            env: {
              PATH: process.env['PATH'] ?? '',
              DATABASE_URL_DIRECT: direct.url,
              WORKOS_API_KEY: WORKOS_KEY,
              NEON_BRANCH_ID: BRANCH,
              DATABASE_URL: other.url,
            },
          },
        ));
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });

    afterAll(async () => {
      await closeAdmin(other?.admin);

      await closeAdmin(direct?.admin);
    });

    it('service/storage#remap service/code-layout#packages: node runs the file, and it connects only to the database of DATABASE_URL_DIRECT, not to DATABASE_URL', async () => {
      expect(stderr).toBe('');

      expect(JSON.parse(stdout)).toMatchObject({
        remapped: [{ apiName: 'alpha', from: ACME, to: ACME_MIRROR }],
        clashes: [],
      });

      await expect.poll(() => sessions(direct)).toBeGreaterThan(usedBefore);

      expect(await sessions(other)).toBe(otherSessionsBefore);

      expect((await registry(direct)).map((r) => r['organization'])).toEqual([ACME_MIRROR]);

      expect(await registry(other)).toEqual(otherBefore);
    });
  });
});

describe('the JSON of the entry', () => {
  it('service/storage#remap: the entry prints the JSON of a remap and of a clash on stdout', async () => {
    const clash = await row(database, 'alpha', ACME);

    const moved = await row(database, 'beta', ACME);

    await row(database, 'alpha', ACME_MIRROR);

    const result = await run(workos({ [ACME]: ACME_MIRROR }));

    expect(JSON.parse(result.stdout)).toEqual({
      remapped: [{ ontologyRid: moved, apiName: 'beta', from: ACME, to: ACME_MIRROR }],
      clashes: [{ ontologyRid: clash, apiName: 'alpha', organization: ACME, mirror: ACME_MIRROR }],
    });
  });

  it('service/storage#remap: for each refusal, the entry prints nothing on stdout and 1 line on stderr', async () => {
    await row(database, 'alpha', ACME);

    const bare = await newDatabase(undefined);

    const holder = new pg.Client({ connectionString: new URL(`/${database.name}`, postgres.url).toString() });

    await holder.connect();

    try {
      await row(bare, 'alpha', ACME);

      const refusals: Run[] = [
        await run(workos({}), { ...ENV(), WORKOS_API_KEY: undefined }),
        await run(workos({ [ACME]: 500 })),
        await run(workos({ [ACME]: ACME_MIRROR }), { ...ENV(), DATABASE_URL_DIRECT: bare.url }),
      ];

      await holder.query('BEGIN');

      await holder.query('LOCK TABLE ontology_registry.product_versions IN EXCLUSIVE MODE');

      refusals.push(await run(workos({ [ACME]: ACME_MIRROR }), ENV(), { lockTimeout: '300ms' }));

      for (const refusal of refusals) {
        expect(refusal.code).toBe(1);
        expect(refusal.stdout).toBe('');
        expect(lines(refusal.stderr)).toHaveLength(1);
      }
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);

      await holder.end();

      await closeAdmin(bare.admin);
    }
  });
});

describe('a deadlock', () => {
  it('service/storage#remap: a real deadlock with a second connection exits 1 with 1 line on stderr with PublishLockTimeout, and changes no row', async () => {
    await row(database, 'alpha', ACME);

    const bolt = await row(database, 'beta', BOLT);

    const before = await registry();

    const holder = new pg.Client({ connectionString: new URL(`/${database.name}`, postgres.url).toString() });

    await holder.connect();

    try {
      await holder.query('BEGIN');

      await holder.query("SET deadlock_timeout = '30s'");

      await holder.query(`SELECT 1 FROM ${ONTOLOGIES} WHERE rid = $1 FOR UPDATE`, [bolt]);

      const running = run(workos({ [ACME]: ACME_MIRROR, [BOLT]: 'org_BOLT_MIRROR' }), ENV(), { lockTimeout: '20s' });

      await expect
        .poll(
          async () =>
            (
              await database.admin.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
                [database.name],
              )
            ).rows[0]?.n,
        )
        .toBe(1);

      const second = holder.query('LOCK TABLE ontology_registry.product_versions IN EXCLUSIVE MODE');

      expect(await running).toEqual({
        code: 1,
        stdout: '',
        stderr:
          'PublishLockTimeout: the wait for the lock of install ended. The remap changed nothing, and a repeat is safe.\n',
      });

      await second;
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);

      await holder.end();
    }

    expect(await registry()).toEqual(before);
  });
});

describe('a failed commit', () => {
  it('service/storage#remap: an error at the commit exits 1 with 1 line that says the result is not known and that a repeat is safe', async () => {
    await row(database, 'alpha', ACME);

    const before = await registry();

    await database.admin.query(
      `CREATE FUNCTION public.refuse_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'marker0commit0never0printed'; END $$`,
    );

    await database.admin.query(
      `CREATE CONSTRAINT TRIGGER refuse_commit AFTER UPDATE ON ${ONTOLOGIES} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.refuse_commit()`,
    );

    expect(await run(workos({ [ACME]: ACME_MIRROR }))).toEqual({
      code: 1,
      stdout: '',
      stderr: 'The remap failed with the database error P0001. Its result is not known, and a repeat is safe.\n',
    });

    expect(await registry()).toEqual(before);
  });
});

describe('an owner that is the empty text', () => {
  it('service/storage#remap: the entry sends no GET for it, and the remap does not change its row', async () => {
    await row(database, 'alpha', '');

    const acme = await row(database, 'beta', ACME);

    const fetch = workos({ '': 'org_EMPTY_MIRROR', [ACME]: ACME_MIRROR });

    const result = await run(fetch);

    expect(fetch.calls.map((call) => call.url)).toEqual([`https://api.workos.com/organizations/external_id/${ACME}`]);

    expect(JSON.parse(result.stdout)).toEqual({
      remapped: [{ ontologyRid: acme, apiName: 'beta', from: ACME, to: ACME_MIRROR }],
      clashes: [],
    });

    expect((await registry()).map((r) => r['organization'])).toEqual(['', ACME_MIRROR]);
  });
});

describe('the answers of the child process of the CLI', () => {
  type Reply = { readonly status: number; readonly body?: string } | 'drop';

  type Rows = readonly (readonly [string, string | null])[];

  const MIRROR_OF_ACME: Reply = { status: 200, body: JSON.stringify({ id: ACME_MIRROR }) };

  const ROWS: Rows = [
    ['alpha', ACME],
    ['beta', BOLT],
  ];

  let workos: Server;
  let origin: string;
  let unreachable: string;
  let folder: string;
  let preload: string;
  let breaker: string;
  let driver: string;
  const caseReplies = new Map<string, Readonly<Record<string, Reply>>>();
  const caseAnswers = new Map<string, unknown>();
  let lockTimeoutAnswer: unknown;
  let deadlockAnswer: unknown;
  let commitErrorAnswer: unknown;

  const originOf = (key: string): string => `${origin}/${key}`;

  async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function child(script: string, env: Readonly<Record<string, string | undefined>>, hook = preload): Promise<Run> {
    return new Promise((resolve, reject) => {
      const entries = Object.entries({ PATH: process.env['PATH'], WORKOS_ORIGIN: origin, ...env }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      );

      const running = spawn(process.execPath, ['--import', hook, script], {
        cwd: SERVICE,
        env: Object.fromEntries(entries),
      });

      let stdout = '';
      let stderr = '';

      running.stdout.on('data', (chunk: Buffer) => (stdout += chunk));

      running.stderr.on('data', (chunk: Buffer) => (stderr += chunk));

      running.on('error', reject);

      running.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  const rid = (index: number): string =>
    `ri.ontology.main.ontology.00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

  async function seed(on: TestDatabase, rows: Rows = ROWS): Promise<void> {
    for (const [index, [apiName, organization]] of rows.entries()) await row(on, apiName, organization, rid(index + 1));
  }

  async function owners(on: TestDatabase): Promise<string[]> {
    return (await registry(on)).map((each) => `${String(each['api_name'])}@${String(each['organization'])}`);
  }

  const environment = (on: TestDatabase) => ({
    DATABASE_URL_DIRECT: on.url,
    WORKOS_API_KEY: WORKOS_KEY,
    NEON_BRANCH_ID: BRANCH,
  });

  async function answerAfter(run: Promise<Run>, on: TestDatabase): Promise<unknown> {
    return { ...(await run), owners: await owners(on) };
  }

  interface Case {
    readonly name: string;
    readonly rows?: Rows;
    readonly replies?: Readonly<Record<string, Reply>>;
    readonly env?: (on: TestDatabase) => Readonly<Record<string, string | undefined>>;
    readonly branch?: 'empty' | 'none';
  }

  const bolt = (answer: Reply): Readonly<Record<string, Reply>> => ({ [ACME]: MIRROR_OF_ACME, [BOLT]: answer });
  const body = (status: number, text?: string): Reply => (text === undefined ? { status } : { status, body: text });
  const databaseAt = (url: string) => () => ({ DATABASE_URL_DIRECT: url });

  const cases: readonly Case[] = [
    { name: 'DATABASE_URL_DIRECT is missing', env: () => ({ DATABASE_URL_DIRECT: undefined }) },
    { name: 'WORKOS_API_KEY is missing', env: () => ({ WORKOS_API_KEY: undefined }) },
    { name: 'NEON_BRANCH_ID is missing', env: () => ({ NEON_BRANCH_ID: undefined }) },
    {
      name: 'each variable is missing',
      env: () => ({ DATABASE_URL_DIRECT: undefined, WORKOS_API_KEY: undefined, NEON_BRANCH_ID: undefined }),
    },
    { name: 'NEON_BRANCH_ID is empty', env: () => ({ NEON_BRANCH_ID: '' }) },
    { name: 'WorkOS answers 500', replies: bolt(body(500, '{"message":"marker0body0never0printed"}')) },
    { name: 'WorkOS answers 401', replies: bolt(body(401, '{}')) },
    { name: 'WorkOS answers 429', replies: bolt(body(429, '{}')) },
    { name: 'WorkOS answers 201 with an id', replies: bolt(body(201, '{"id":"org_BOLT_MIRROR"}')) },
    { name: 'WorkOS answers 204 with no body', replies: bolt(body(204)) },
    { name: 'WorkOS answers 200 with no id', replies: bolt(body(200, '{"object":"organization"}')) },
    { name: 'WorkOS answers 200 with an empty id', replies: bolt(body(200, '{"id":""}')) },
    { name: 'WorkOS answers 200 with an id that is not text', replies: bolt(body(200, '{"id":7}')) },
    { name: 'WorkOS answers 200 with a body that is not JSON', replies: bolt(body(200, 'not json')) },
    { name: 'WorkOS answers 200 with the JSON null', replies: bolt(body(200, 'null')) },
    { name: 'WorkOS drops the connection', replies: bolt('drop') },
    { name: 'WorkOS is not reachable', env: () => ({ WORKOS_ORIGIN: unreachable }) },
    {
      name: 'the owner ID has a slash',
      rows: [['alpha', 'org/odd']],
      replies: { 'org/odd': { status: 200, body: JSON.stringify({ id: 'org_ODD_MIRROR' }) } },
    },
    { name: 'NEON_BRANCH_ID differs from neon.branch_id', env: () => ({ NEON_BRANCH_ID: 'br-production-0002' }) },
    { name: 'neon.branch_id is empty', branch: 'empty' },
    { name: 'the database has no neon.branch_id', branch: 'none' },
    {
      name: 'the connection is refused',
      env: databaseAt(`postgresql://ontology_service:${MARKER}@127.0.0.1:1/neondb`),
    },
    {
      name: 'the connection string is malformed',
      env: databaseAt(`postgresql://ontology_service:${MARKER}@[bad/neondb`),
    },
    {
      name: 'the password is wrong',
      env: (on) => ({ DATABASE_URL_DIRECT: on.url.replace(/\/\/[^@]*@/, `//ontology_service:${MARKER}@`) }),
    },
    { name: 'no owner has a Mirror Organization', replies: {} },
    { name: 'the registry has no row', rows: [] },
    {
      name: 'each owner has a Mirror Organization',
      rows: [
        ['alpha', ACME],
        ['beta', ACME],
        ['gamma', null],
        ['delta', ''],
      ],
    },
    {
      name: 'a Mirror Organization has an Ontology of the API name',
      rows: [
        ['alpha', ACME],
        ['beta', ACME],
        ['alpha', ACME_MIRROR],
      ],
    },
  ];

  beforeAll(async () => {
    workos = createServer((request, response) => {
      const segments = (request.url ?? '').split('/');
      const table = caseReplies.get(segments[1] ?? '') ?? {};
      const owner = decodeURIComponent(segments.at(-1) ?? '');
      const reply = table[owner] ?? { status: 404, body: '{}' };

      if (reply === 'drop') {
        request.socket.destroy();

        return;
      }

      response.writeHead(reply.status, { 'content-type': 'application/json' });

      response.end(reply.body);
    });

    origin = await listen(workos);

    const closed = createServer();

    unreachable = await listen(closed);

    await new Promise((resolve) => closed.close(resolve));

    folder = mkdtempSync(join(tmpdir(), 'remap-entry-record-'));

    preload = join(folder, 'workos.mjs');

    writeFileSync(
      preload,
      `const real = globalThis.fetch;\nglobalThis.fetch = (input, init) => real(String(input).replace('https://api.workos.com', process.env.WORKOS_ORIGIN), init);\n`,
    );

    breaker = join(folder, 'breaker.mjs');

    writeFileSync(
      breaker,
      `const real = globalThis.fetch;\nglobalThis.fetch = (input, init) => real(String(input).replace('https://api.workos.com', process.env.WORKOS_ORIGIN), init);\n` +
        `const stream = process[process.env.BREAK];\nconst write = stream.write.bind(stream);\nlet broken = false;\n` +
        `stream.write = (...args) => {\n  if (broken) return write(...args);\n  broken = true;\n  throw new RangeError(process.env.BREAK + '0broke');\n};\n`,
    );

    driver = join(folder, 'lockTimeout.mjs');

    writeFileSync(
      driver,
      `import { main } from ${JSON.stringify(pathToFileURL(ENTRY).href)};\n` +
        `process.exitCode = await main({ env: process.env, fetch: globalThis.fetch, stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text), lockTimeout: '300ms' });\n`,
    );
  });

  async function runCaseBatch(offset: number, batch: readonly Case[]): Promise<void> {
    const prepared: { readonly each: Case; readonly key: string; readonly on: TestDatabase }[] = [];

    for (const [index, each] of batch.entries()) {
      const key = `case-${offset + index}`;

      const on = await newDatabase(each.branch === undefined ? BRANCH : each.branch === 'empty' ? '' : undefined);

      await seed(on, each.rows);

      caseReplies.set(key, each.replies ?? { [ACME]: MIRROR_OF_ACME });

      prepared.push({ each, key, on });
    }

    await Promise.all(
      prepared.map(async ({ each, key, on }) => {
        try {
          caseAnswers.set(
            each.name,
            await answerAfter(
              child(ENTRY, { ...environment(on), WORKOS_ORIGIN: originOf(key), ...each.env?.(on) }),
              on,
            ),
          );
        } finally {
          await closeAdmin(on.admin);
        }
      }),
    );
  }

  beforeAll(() => runCaseBatch(0, cases.slice(0, 10)), 60_000);

  beforeAll(() => runCaseBatch(10, cases.slice(10, 20)), 60_000);

  beforeAll(() => runCaseBatch(20, cases.slice(20)), 60_000);

  beforeAll(async () => {
    const lockDb = await newDatabase(BRANCH);

    const deadlockDb = await newDatabase(BRANCH);

    const commitDb = await newDatabase(BRANCH);

    await Promise.all([
      (async () => {
        const holder = new pg.Client({ connectionString: new URL(`/${lockDb.name}`, postgres.url).toString() });

        try {
          await seed(lockDb);

          await holder.connect();

          await holder.query('BEGIN');

          await holder.query('LOCK TABLE ontology_registry.product_versions IN EXCLUSIVE MODE');

          caseReplies.set('lock-timeout', { [ACME]: MIRROR_OF_ACME });

          lockTimeoutAnswer = await answerAfter(
            child(driver, { ...environment(lockDb), WORKOS_ORIGIN: originOf('lock-timeout') }),
            lockDb,
          );
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);

          await holder.end();

          await closeAdmin(lockDb.admin);
        }
      })(),
      (async () => {
        const holder = new pg.Client({ connectionString: new URL(`/${deadlockDb.name}`, postgres.url).toString() });

        try {
          await seed(deadlockDb);

          await holder.connect();

          await holder.query('BEGIN');

          await holder.query("SET deadlock_timeout = '30s'");

          await holder.query(`SELECT 1 FROM ${ONTOLOGIES} WHERE rid = $1 FOR UPDATE`, [rid(2)]);

          caseReplies.set('deadlock', {
            [ACME]: MIRROR_OF_ACME,
            [BOLT]: { status: 200, body: JSON.stringify({ id: 'org_BOLT_MIRROR' }) },
          });

          const running = child(ENTRY, { ...environment(deadlockDb), WORKOS_ORIGIN: originOf('deadlock') });

          await vi.waitFor(
            async () => {
              const { rows } = await deadlockDb.admin.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
                [deadlockDb.name],
              );

              if (rows[0]?.n !== 1) throw new Error('Waiting for lock.');
            },
            { timeout: 5_000, interval: 25 },
          );

          const second = holder.query('LOCK TABLE ontology_registry.product_versions IN EXCLUSIVE MODE');

          deadlockAnswer = await answerAfter(running, deadlockDb);

          await second;
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);

          await holder.end();

          await closeAdmin(deadlockDb.admin);
        }
      })(),
      (async () => {
        try {
          await seed(commitDb);

          await commitDb.admin.query(
            `CREATE FUNCTION public.refuse_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'marker0commit0never0printed'; END $$`,
          );

          await commitDb.admin.query(
            `CREATE CONSTRAINT TRIGGER refuse_commit AFTER UPDATE ON ${ONTOLOGIES} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.refuse_commit()`,
          );

          caseReplies.set('commit-error', { [ACME]: MIRROR_OF_ACME });

          commitErrorAnswer = await answerAfter(
            child(ENTRY, { ...environment(commitDb), WORKOS_ORIGIN: originOf('commit-error') }),
            commitDb,
          );
        } finally {
          await closeAdmin(commitDb.admin);
        }
      })(),
    ]);
  });

  afterAll(async () => {
    workos?.closeAllConnections();

    await new Promise((resolve) => workos?.close(resolve));

    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  for (const { name } of cases) {
    it(name, () => {
      expect(caseAnswers.get(name)).toMatchSnapshot();
    });
  }

  describe('a stdout that throws', () => {
    let stdoutRun: Run;
    let stdoutOwners: string[];

    beforeAll(async () => {
      const on = await newDatabase(BRANCH);

      try {
        await seed(on);

        caseReplies.set('stdout-throws', { [ACME]: MIRROR_OF_ACME });

        stdoutRun = await child(
          ENTRY,
          { ...environment(on), WORKOS_ORIGIN: originOf('stdout-throws'), BREAK: 'stdout' },
          breaker,
        );

        stdoutOwners = await owners(on);
      } finally {
        await closeAdmin(on.admin);
      }
    });

    it('a stdout that throws on the result gets the line of a database error, and the remap commits', () => {
      expect(stdoutRun).toEqual({
        code: 1,
        stdout: '',
        stderr: 'The remap failed with the database error RangeError. Its result is not known, and a repeat is safe.\n',
      });

      expect(stdoutOwners).toEqual([`alpha@${ACME_MIRROR}`, `beta@${BOLT}`]);
    });
  });

  describe('a stderr that throws', () => {
    const rejected = 'RangeError: stderr0broke';
    let missingRun: Run;
    let workos500Run: Run;

    beforeAll(async () => {
      const missingDb = await newDatabase(BRANCH);

      const workos500Db = await newDatabase(BRANCH);

      await seed(missingDb);

      await seed(workos500Db);

      caseReplies.set('stderr-500', bolt(body(500, '{}')));

      try {
        [missingRun, workos500Run] = await Promise.all([
          child(
            ENTRY,
            {
              ...environment(missingDb),
              WORKOS_ORIGIN: originOf('stderr-missing'),
              WORKOS_API_KEY: undefined,
              BREAK: 'stderr',
            },
            breaker,
          ),
          child(
            ENTRY,
            { ...environment(workos500Db), WORKOS_ORIGIN: originOf('stderr-500'), BREAK: 'stderr' },
            breaker,
          ),
        ]);
      } finally {
        await closeAdmin(missingDb.admin);

        await closeAdmin(workos500Db.admin);
      }
    });

    it('a stderr that throws on the line of a missing variable rejects main, so the entry exits 1 with the error on stderr', () => {
      expect(missingRun.code).toBe(1);
      expect(missingRun.stdout).toBe('');
      expect(missingRun.stderr).toContain(rejected);
    });

    it('a stderr that throws on the line of a WorkOS 500 rejects main, so the entry exits 1 with the error on stderr', () => {
      expect(workos500Run.code).toBe(1);
      expect(workos500Run.stdout).toBe('');
      expect(workos500Run.stderr).toContain(rejected);
    });
  });

  it('the wait for the lock of install ends', () => {
    expect(lockTimeoutAnswer).toMatchSnapshot();
  });

  it('a deadlock with a second connection', () => {
    expect(deadlockAnswer).toMatchSnapshot();
  });

  it('an error at the commit', () => {
    expect(commitErrorAnswer).toMatchSnapshot();
  });
});
