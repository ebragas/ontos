import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileTokenStore } from './auth/store.ts';
import { orThrow } from './fallible.ts';
import type { Io } from './io.ts';
import { run } from './main.ts';
import {
  cli,
  stubExchange,
  replay,
  runLibraryInFolder,
  STUB,
  stubConfig,
  stubFetch,
  tempFolder,
  withRequest,
  type Handler,
} from './cli.test-utils.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const ACCOUNT = 'com.example.twin.Account';
const ENGAGEMENT = 'com.example.twin.Engagement';
const TARGET = ['--app', 'twin', '--url', STUB];
const ENV = { ONTOLOGY_TOKEN: 't' };

function answer(code: number, stdout: string, stderr: string, cwd: string): unknown {
  const plain = (text: string): string => (cwd === '' ? text : text.replaceAll(cwd, '<cwd>'));

  return { code, stdout: plain(stdout), stderr: plain(stderr) };
}

interface Case {
  readonly name: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

const crash: Handler = ({ url }) =>
  url.includes('/api/v2/')
    ? Response.json({ error: 'crash' }, { status: 500, statusText: 'Internal Server Error' })
    : undefined;

const CASES: readonly Case[] = [
  { name: '--version with a command', args: ['--version', 'extra'] },
  { name: '--version with another flag', args: ['--version', '--local'] },
  {
    name: '--version with a flag and a value',
    args: ['--version', '--app', 'twin'],
  },
  { name: 'no command', args: [] },
  { name: 'an unknown command', args: ['nope'] },
  { name: 'an unknown command with a flag', args: ['nope', '--app', 'twin'] },
  { name: 'an empty command', args: [''] },
  { name: 'a command that is a property of Object', args: ['constructor'] },
  { name: 'a command that is a key of the prototype', args: ['__proto__'] },
  { name: 'an unknown flag', args: ['objects', ACCOUNT, '--nope'] },
  { name: 'a flag with no value', args: ['objects', ACCOUNT, '--app'] },
  {
    name: 'a flag that takes no value, with a value',
    args: ['validate', '--local=yes'],
  },
  { name: 'a short flag', args: ['objects', '-x'] },
  {
    name: 'an error of a command: an empty --org',
    args: ['login', '--org=', ...TARGET],
    env: ENV,
  },
  {
    name: 'an error of a command: too many arguments',
    args: ['logout', 'extra', ...TARGET],
    env: ENV,
  },
  { name: 'an error of a command: no target', args: ['objects', ACCOUNT] },
  {
    name: 'an error of the service: an OSDK error body',
    args: ['objects', ENGAGEMENT, '--where', '{"nope":{"$eq":"x"}}', ...TARGET],
    env: ENV,
    fetch: stubFetch(
      stubConfig,
      replay(stubExchange('client', 4), withRequest(stubExchange('client', 22), { pageSize: 100 })),
    ),
  },
  {
    name: 'an error of the service: an answer that is not an OSDK error body',
    args: ['objects', ACCOUNT, ...TARGET],
    env: ENV,
    fetch: stubFetch(stubConfig, crash),
  },
  {
    name: 'an error of the service: a fetch that rejects',
    args: ['objects', ACCOUNT, ...TARGET],
    env: ENV,
    fetch: (() => Promise.reject(new Error('no network in this test'))) as typeof fetch,
  },
];

describe('service/cli#output', () => {
  for (const { name, args, env, fetch } of CASES) {
    it(name, async () => {
      const cwd = tempFolder();

      const result = await cli(args, {
        cwd,
        ...(env && { env }),
        ...(fetch && { fetch }),
      });

      expect(answer(result.code, result.stdout, result.stderr, cwd)).toMatchSnapshot();
    });
  }
});

async function ioAnswer(args: readonly string[], fail: (io: Io) => Io): Promise<unknown> {
  let stdout = '';
  let stderr = '';
  const cwd = tempFolder();

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The run uses only these fields of the io.
  const base = {
    cwd,
    env: {},
    stdout: (text: string) => void (stdout += text),
    stderr: (text: string) => void (stderr += text),
  } as unknown as Io;

  const code = await run(args, fail(base));

  return answer(code, stdout, stderr, cwd);
}

describe('service/cli#output: a failure of the io', () => {
  it('a stdout that throws an Error', async () => {
    expect(
      await ioAnswer(['--version'], (io) => ({
        ...io,
        stdout: () => {
          throw new Error('stdout is closed');
        },
      })),
    ).toMatchSnapshot();
  });

  it('a stdout that throws a string', async () => {
    expect(
      await ioAnswer(['--version'], (io) => ({
        ...io,
        stdout: () => {
          throw 'stdout is closed';
        },
      })),
    ).toMatchSnapshot();
  });

  it('a stdout that throws an Error with a cause that is an Error', async () => {
    expect(
      await ioAnswer(['--version'], (io) => ({
        ...io,
        stdout: () => {
          throw new Error('outer', { cause: new Error('inner') });
        },
      })),
    ).toMatchSnapshot();
  });
});

describe('service/cli#library-entry: a default that throws', () => {
  it('a current folder that is removed gives the JSON error and exit code 1, with no command run', () => {
    const { code, stdout, stderr } = runLibraryInFolder(tempFolder(), ['--version'], { remove: true });

    expect({ code, stdout }).toEqual({ code: 1, stdout: '' });

    expect(JSON.parse(stderr)).toEqual({
      message: expect.stringMatching(/^ENOENT: .*no such file or directory.*uv_cwd$/u),
    });
  });
});

describe('service/cli#sign-in: the token store with a path that fails', () => {
  async function failureOf(call: () => Promise<void>): Promise<unknown> {
    try {
      await call();

      return 'no failure';
    } catch (error) {
      const { code, syscall } = error as NodeJS.ErrnoException;

      return { code, syscall };
    }
  }

  it('a key whose lock name is too long', async () => {
    const store = orThrow(fileTokenStore(tempFolder()));

    expect(await failureOf(() => store.write(`app/${'x'.repeat(252)}`, 'token'))).toMatchSnapshot();
  });

  it('a key whose folder is a file', async () => {
    const folder = tempFolder({ app: 'a file' });

    expect(await failureOf(() => orThrow(fileTokenStore(folder)).write('app/staging', 'token'))).toMatchSnapshot();
  });
});
