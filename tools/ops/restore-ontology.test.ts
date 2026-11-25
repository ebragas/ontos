import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exitCodeOf } from './args.ts';
import { connectionLine, main } from './restore-ontology.ts';

const SOURCE = readFileSync(new URL('./restore-ontology.ts', import.meta.url), 'utf8');
const ARGS = readFileSync(new URL('./args.ts', import.meta.url), 'utf8');
const RID = 'ri.ontology.main.ontology.1';
const UNREACHABLE = 'postgres://ontology_service:marker-password@127.0.0.1:1/neondb';

function importsOf(source: string): string[] {
  return [...source.matchAll(/^import (?!type )[\s\S]*? from '([^']+)';$/gm)].map((match) => match[1] ?? '');
}

async function run(
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout = vi.spyOn(console, 'log');
  const stderr = vi.spyOn(console, 'error');

  try {
    const code = await main(args, env);

    return {
      code,
      stdout: stdout.mock.calls.map(([text]) => String(text)),
      stderr: stderr.mock.calls.map(([text]) => String(text)),
    };
  } finally {
    vi.restoreAllMocks();
  }
}

describe('the source of the restore script', () => {
  it('service/code-layout#seams: imports values only from packages/service/src/publish/, packages/service/src/db/, and packages/service/src/errors/, and its shared argument rules from args.ts', () => {
    expect(importsOf(SOURCE)).toEqual([
      '../../packages/service/src/db/index.ts',
      '../../packages/service/src/errors/index.ts',
      '../../packages/service/src/publish/restore.ts',
      './args.ts',
    ]);

    expect(SOURCE).toMatch(/createPool\(/);
    expect(SOURCE).toMatch(/createDb\(/);
  });

  it('service/storage#restore: the entry passes no lock wait and no clock to main, so the switch and drop use the release value 90s', () => {
    expect(SOURCE).toContain(
      'if (import.meta.main) {\n  const ran = await caught(() => main(process.argv.slice(2), process.env));',
    );

    expect(SOURCE).not.toMatch(/lockTimeout: '/);
  });
});

describe('the connection line of the restore script', () => {
  it('service/storage#restore: an error whose code read throws gives the side and the line with no error code, on 1 line', () => {
    const hostile = Object.defineProperty(new Error('postgres://role:marker-password@host/db'), 'code', {
      get() {
        throw new Error('postgres://role:marker-password@host/db');
      },
    });

    expect(connectionLine('source', hostile)).toBe(
      'The source connection failed. The command failed with no error code.',
    );

    expect(connectionLine('production', { code: '28P01' })).toBe(
      'The production connection failed. The command failed with the error code 28P01. The password or the role is wrong.',
    );
  });
});

describe('the variables of the restore script', () => {
  it.each([
    ['DATABASE_URL_DIRECT', { RESTORE_SOURCE_URL: UNREACHABLE }, 'DATABASE_URL_DIRECT is not set.'],
    ['RESTORE_SOURCE_URL', { DATABASE_URL_DIRECT: UNREACHABLE }, 'RESTORE_SOURCE_URL is not set.'],
    ['both', {}, 'DATABASE_URL_DIRECT and RESTORE_SOURCE_URL are not set.'],
  ])(
    'service/storage#restore: restore with %s missing exits 1 before any call, and names each missing variable',
    async (_name, env, message) => {
      for (const args of [
        ['restore', RID],
        ['restore', RID, '--write', '--confirm-rid', RID],
      ]) {
        const result = await run(args, env);

        expect(result.code).toBe(1);
        expect(result.stdout).toEqual([]);
        expect(result.stderr).toHaveLength(1);
        expect(result.stderr).toEqual([message]);
      }
    },
  );

  it('service/storage#restore: drop with no DATABASE_URL_DIRECT exits 1 before any call, and names it; drop needs no RESTORE_SOURCE_URL', async () => {
    const result = await run(['drop', 'ontology_1_objects', '--write', '--confirm-schema', 'ontology_1_objects'], {
      RESTORE_SOURCE_URL: UNREACHABLE,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toHaveLength(1);
    expect(result.stderr).toEqual(['DATABASE_URL_DIRECT is not set.']);
  });
});

describe('the shared argument rules of the scripts', () => {
  it('args.ts imports only node:util and the helper of yielded failures, and holds no SQL', () => {
    expect(importsOf(ARGS)).toEqual(['node:util', '../../packages/service/src/errors/fallible.ts']);
    expect(ARGS).not.toMatch(/\b(SELECT|UPDATE|INSERT|DELETE|FOR UPDATE|set_config|lock_timeout|statement_timeout)\b/i);
    expect(ARGS).not.toMatch(/\.query\(|\.transaction\(/);
  });
});

async function failureOf(thrown: unknown): Promise<{ code: number; lines: string[] }> {
  const stderr = vi.spyOn(console, 'error');

  const code = await exitCodeOf(() => Promise.reject(thrown));

  const lines = stderr.mock.calls.flatMap((call) => call.map(String).join(' ').split('\n'));

  return { code, lines };
}

const MARKED_URL = 'postgres://u:marker@h/db';

describe('exitCodeOf', () => {
  afterEach(() => vi.restoreAllMocks());

  class FooError extends Error {}

  const NO_SSL = 'The server does not support SSL connections';

  const throwing = (key: string): object =>
    Object.defineProperty(new Error(MARKED_URL), key, {
      get: () => {
        throw new Error(MARKED_URL);
      },
    });

  const LONG_CODE = 'E'.repeat(65);

  it.each([
    [
      'a known code',
      Object.assign(new Error(MARKED_URL), { code: '28P01' }),
      'The command failed with the error code 28P01. The password or the role is wrong.',
    ],
    [
      'another known code',
      Object.assign(new Error(MARKED_URL), { code: '3D000' }),
      'The command failed with the error code 3D000. The database of the URL does not exist.',
    ],
    [
      'a code of a bad URL, with an input field',
      Object.assign(new TypeError(MARKED_URL), { code: 'ERR_INVALID_URL', input: MARKED_URL }),
      'The command failed with the error code ERR_INVALID_URL. A database URL is not a URL.',
    ],
    [
      'an unknown code',
      Object.assign(new Error(MARKED_URL), { code: '99999' }),
      'The command failed with the error code 99999.',
    ],
    [
      'a code that is a key of Object.prototype',
      Object.assign(new Error(MARKED_URL), { code: 'toString' }),
      'The command failed with the error code toString.',
    ],
    [
      'a code of 64 word characters',
      Object.assign(new Error(MARKED_URL), { code: 'E'.repeat(64) }),
      `The command failed with the error code ${'E'.repeat(64)}.`,
    ],
    [
      'a code of 65 word characters',
      Object.assign(new Error(MARKED_URL), { code: LONG_CODE }),
      'The command failed with an error code that is not 1 word.',
    ],
    [
      'a TLS code with a slash',
      Object.assign(new Error(MARKED_URL), { code: 'ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE' }),
      'The command failed with an error code that is not 1 word.',
    ],
    [
      'a code that holds the URL',
      Object.assign(new Error('boom'), { code: MARKED_URL }),
      'The command failed with an error code that is not 1 word.',
    ],
    [
      'the plain Error of pg for a server with no SSL',
      new Error(NO_SSL),
      'The command failed with no error code. The error class is Error. The server does not accept SSL. Use a TLS-enabled or direct PostgreSQL connection string.',
    ],
    [
      'another plain Error with no code',
      new Error(MARKED_URL),
      'The command failed with no error code. The error class is Error.',
    ],
    [
      'the other SSL Error of pg',
      new Error('There was an error establishing an SSL connection'),
      'The command failed with no error code. The error class is Error.',
    ],
    [
      'a plain Error whose message starts with the SSL text',
      new Error(`${NO_SSL} ${MARKED_URL}`),
      'The command failed with no error code. The error class is Error.',
    ],
    [
      'an error of another class with no code',
      new FooError(MARKED_URL),
      'The command failed with no error code. The error class is FooError.',
    ],
    [
      'an error of another class with the SSL message',
      new FooError(NO_SSL),
      'The command failed with no error code. The error class is FooError. The server does not accept SSL. Use a TLS-enabled or direct PostgreSQL connection string.',
    ],
    [
      'an error with a code that is not a string',
      Object.assign(new FooError(MARKED_URL), { code: 42 }),
      'The command failed with no error code. The error class is FooError.',
    ],
    ['a string', MARKED_URL, 'The command failed with no error code.'],
    ['null', null, 'The command failed with no error code.'],
    [
      'an object with no prototype',
      Object.assign(Object.create(null) as object, { message: MARKED_URL }),
      'The command failed with no error code.',
    ],
    [
      'an object whose class name is not a word',
      Object.create({ constructor: { name: MARKED_URL } }) as object,
      'The command failed with no error code.',
    ],
    ['an error whose code getter throws', throwing('code'), 'The command failed with no error code.'],
    ['an error whose message getter throws', throwing('message'), 'The command failed with no error code.'],
    [
      'an object whose constructor getter throws',
      Object.create(
        Object.defineProperty({}, 'constructor', {
          get: () => {
            throw new Error(MARKED_URL);
          },
        }),
      ) as object,
      'The command failed with no error code.',
    ],
    [
      'a Proxy that throws on each read',
      new Proxy(
        {},
        {
          get: () => {
            throw new Error(MARKED_URL);
          },
          getPrototypeOf: () => {
            throw new Error(MARKED_URL);
          },
        },
      ),
      'The command failed with no error code.',
    ],
  ])(
    'service/storage#restore: %s gives exit 1 and 1 fixed line that holds no message and no URL',
    async (_name, thrown, line) => {
      const failure = await failureOf(thrown);

      expect(failure).toEqual({ code: 1, lines: [line] });
      expect(failure.lines.join('\n')).not.toContain('marker');
      expect(failure.lines.join('\n')).not.toContain('postgres://');
    },
  );
});
