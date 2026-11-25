import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { attempt, caught, settle, type AsyncFallible, type Fallible } from '../fallible.ts';
import type { TokenStore, Variables } from '../io.ts';

const STALE_LOCK_MS = 10_000;

const LOCK_WAIT_MS = 10;

function raise(error: unknown): never {
  // oxlint-disable-next-line fallible/no-throw -- D1: the TokenStore of the public entry is a Promise port, and its callers read the error that a file operation threw.
  throw error;
}

function* readIfExists(path: string): Fallible<string | undefined, unknown> {
  const read = caught(() => (existsSync(path) ? readFileSync(path, 'utf8') : undefined));

  if (!read.ok) return yield read.error;

  return read.value;
}

function* readToken(path: string): Fallible<string | undefined, unknown> {
  return (yield* readIfExists(path))?.trim();
}

function* fileOf(folder: string, key: string): Fallible<string, unknown> {
  const joined = caught(() => join(folder, key));

  if (!joined.ok) return yield joined.error;

  if (key.includes('\0')) return yield new Error('A token store key cannot contain a NUL byte.');

  const resolved = resolve(joined.value);
  const rel = relative(folder, resolved);

  if (rel === '' || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel))
    return yield new Error(`Token store key escapes the store folder: ${key}.`);

  return resolved;
}

function* makeFolder(folder: string, key: string): Fallible<string, unknown> {
  const file = yield* fileOf(folder, key);
  const dir = dirname(file);

  const made = caught(() => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    chmodSync(dir, 0o700);
  });

  if (!made.ok) return yield made.error;

  return file;
}

function* release(lock: string, holder: string): Fallible<void, unknown> {
  if ((yield* readIfExists(lock)) !== holder) return;

  const removed = caught(() => rmSync(lock, { force: true }));

  if (!removed.ok) return yield removed.error;
}

async function* locked(file: string, change: () => Fallible<void, unknown>): AsyncFallible<void, unknown> {
  const lock = `${file}.lock`;
  const holder = `${process.pid} ${randomUUID()}`;

  for (;;) {
    const made = caught(() => writeFileSync(lock, holder, { flag: 'wx', mode: 0o600 }));

    if (made.ok) break;

    if ((made.error as NodeJS.ErrnoException).code !== 'EEXIST') return yield made.error;

    const held = caught(() => statSync(lock, { throwIfNoEntry: false }));

    if (!held.ok) return yield held.error;

    if (held.value && Math.abs(Date.now() - held.value.mtimeMs) > STALE_LOCK_MS) {
      const removed = caught(() => rmSync(lock, { force: true }));

      if (!removed.ok) return yield removed.error;
    } else
      yield* attempt(
        () => new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS)),
        (error: unknown) => error,
      );
  }

  const changed = settle(change());
  const released = settle(release(lock, holder));

  if (!released.ok) return yield released.error;

  if (!changed.ok) return yield changed.error;
}

const promised = (run: AsyncFallible<void, unknown>): Promise<void> =>
  settle(run).then((done) => (done.ok ? undefined : raise(done.error)));

export function* fileTokenStore(folder: string): Fallible<TokenStore, unknown> {
  const real = yield* realFolder(folder);
  const held = fileStores.get(real);

  if (held) return held;

  const store = newFileTokenStore(real);

  fileStores.set(real, store);

  return store;
}

const fileStores = new Map<string, TokenStore>();

function* realFolder(folder: string): Fallible<string, unknown> {
  const real = caught(() => {
    let existing = resolve(folder);
    const missing: string[] = [];

    while (!existsSync(existing) && dirname(existing) !== existing) {
      missing.unshift(basename(existing));

      existing = dirname(existing);
    }

    return join(realpathSync(existing), ...missing);
  });

  if (!real.ok) return yield real.error;

  return real.value;
}

function newFileTokenStore(folder: string): TokenStore {
  return {
    read: (key) => {
      const file = settle(fileOf(folder, key));

      if (!file.ok) return raise(file.error);

      const token = settle(readToken(file.value));

      return token.ok ? Promise.resolve(token.value) : raise(token.error);
    },
    write: (key, token, expected) => {
      const file = settle(makeFolder(folder, key));

      if (!file.ok) return raise(file.error);

      return promised(
        locked(file.value, function* (): Fallible<void, unknown> {
          if (expected !== undefined && (yield* readToken(file.value)) !== expected) return;

          const temporary = `${file.value}.${process.pid}.tmp`;

          const written = caught(() => {
            rmSync(temporary, { force: true });

            writeFileSync(temporary, token, { flag: 'wx', mode: 0o600 });

            chmodSync(temporary, 0o600);

            renameSync(temporary, file.value);
          });

          if (!written.ok) {
            caught(() => rmSync(temporary, { force: true }));

            return yield written.error;
          }
        }),
      );
    },
    remove: (key) => {
      const file = settle(fileOf(folder, key));

      if (!file.ok) return raise(file.error);

      if (!existsSync(dirname(file.value))) return Promise.resolve();

      return promised(
        locked(file.value, function* (): Fallible<void, unknown> {
          const removed = caught(() => rmSync(file.value, { force: true }));

          if (!removed.ok) return yield removed.error;
        }),
      );
    },
  };
}

export function* configTokenStore(env: Variables): Fallible<TokenStore, unknown> {
  const folder = caught(() =>
    join(env['XDG_CONFIG_HOME'] || join(env['HOME'] || homedir(), '.config'), 'ontos', 'tokens'),
  );

  if (!folder.ok) return yield folder.error;

  return yield* fileTokenStore(folder.value);
}
