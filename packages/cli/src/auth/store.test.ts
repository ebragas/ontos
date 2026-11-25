import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { orThrow } from '../fallible.ts';
import { configTokenStore } from './store.ts';
import { tempFolder } from '../cli.test-utils.ts';

const mode = (path: string): number => statSync(path).mode & 0o777;

const writer = async (
  config: string,
  key: string,
  count: number,
  start: number,
): Promise<{ first: number; last: number }> => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    `const { configTokenStore } = await import(${JSON.stringify(new URL('./store.ts', import.meta.url).href)});
     const { orThrow } = await import(${JSON.stringify(new URL('../fallible.ts', import.meta.url).href)});
     const store = orThrow(configTokenStore({ XDG_CONFIG_HOME: ${JSON.stringify(config)} }));
     while (Date.now() < ${start});
     const first = Date.now();
     for (let n = 1; n <= ${count}; n += 1) await store.write(${JSON.stringify(key)}, ${JSON.stringify(key)} + '-' + n);
     console.log(JSON.stringify({ first, last: Date.now() }));`,
  ]);

  return JSON.parse(stdout) as { first: number; last: number };
};

describe('the token store', () => {
  it("service/cli#sign-in: the store keeps each refresh token in its own file in the user's config folder, readable only by its owner", async () => {
    const config = tempFolder();
    const store = orThrow(configTokenStore({ XDG_CONFIG_HOME: config }));

    await store.write('acme/staging', 'r1');

    await store.write('acme/production', 'r2');

    const tokens = join(config, 'ontos', 'tokens');

    expect(readFileSync(join(tokens, 'acme', 'staging'), 'utf8')).toBe('r1');
    expect(readFileSync(join(tokens, 'acme', 'production'), 'utf8')).toBe('r2');
    expect(readdirSync(join(tokens, 'acme')).sort()).toEqual(['production', 'staging']);
    expect(mode(join(tokens, 'acme', 'staging'))).toBe(0o600);
    expect(mode(join(tokens, 'acme', 'production'))).toBe(0o600);
    expect(mode(join(tokens, 'acme'))).toBe(0o700);
    expect(mode(tokens)).toBe(0o700);
    expect(mode(join(config, 'ontos'))).toBe(0o700);

    expect(await store.read('acme/staging')).toBe('r1');

    expect(await store.read('acme/other')).toBeUndefined();

    await store.write('acme/staging', 'r3');

    expect(await store.read('acme/staging')).toBe('r3');

    expect(mode(join(tokens, 'acme', 'staging'))).toBe(0o600);

    await store.remove('acme/staging');

    expect(existsSync(join(tokens, 'acme', 'staging'))).toBe(false);

    expect(await store.read('acme/production')).toBe('r2');
  });

  it('service/cli#sign-in: with no XDG_CONFIG_HOME, or an empty one, the config folder is ~/.config', async () => {
    const home = tempFolder();

    await orThrow(configTokenStore({ HOME: home })).write('acme/production', 'r1');

    expect(readFileSync(join(home, '.config', 'ontos', 'tokens', 'acme', 'production'), 'utf8')).toBe('r1');

    await orThrow(configTokenStore({ XDG_CONFIG_HOME: '', HOME: home })).write('acme/staging', 'r2');

    expect(readFileSync(join(home, '.config', 'ontos', 'tokens', 'acme', 'staging'), 'utf8')).toBe('r2');
  });

  describe('concurrent writers', () => {
    let config: string;
    let staging: { first: number; last: number };
    let production: { first: number; last: number };

    beforeAll(async () => {
      config = tempFolder();

      const start = Date.now() + 2000;

      [staging, production] = await Promise.all([
        writer(config, 'acme/staging', 200, start),
        writer(config, 'acme/production', 200, start),
      ]);
    });

    it('service/cli#sign-in: 2 processes that write the tokens of different environments at the same time both keep their last token', async () => {
      expect(Math.max(staging.first, production.first)).toBeLessThan(Math.min(staging.last, production.last));

      const store = orThrow(configTokenStore({ XDG_CONFIG_HOME: config }));

      expect(await store.read('acme/staging')).toBe('acme/staging-200');

      expect(await store.read('acme/production')).toBe('acme/production-200');
    });
  });

  it('service/cli#sign-in: a write with the token it expects waits for the lock of another writer, then compares, and writes only when the file still holds that token', async () => {
    const config = tempFolder();
    const store = orThrow(configTokenStore({ XDG_CONFIG_HOME: config }));
    const tokens = join(config, 'ontos', 'tokens');
    const file = join(tokens, 'acme', 'staging');

    const otherWriter = async (write: () => Promise<void>, token: string): Promise<void> => {
      writeFileSync(`${file}.lock`, 'other');

      const waiting = write();

      await new Promise((resolve) => setTimeout(resolve, 100));

      writeFileSync(file, token);

      rmSync(`${file}.lock`);

      await waiting;
    };

    await store.write('acme/staging', 'r1');

    await otherWriter(() => store.write('acme/staging', 'r2', 'r1'), 'r9');

    expect(await store.read('acme/staging')).toBe('r9');

    await otherWriter(() => store.write('acme/staging', 'r10', 'r9'), 'r9');

    expect(await store.read('acme/staging')).toBe('r10');

    writeFileSync(`${file}.lock`, 'stopped');

    const old = new Date(Date.now() - 11_000);

    utimesSync(`${file}.lock`, old, old);

    await store.write('acme/staging', 'r3', 'r10');

    expect(await store.read('acme/staging')).toBe('r3');

    await store.remove('acme/staging');

    await store.write('acme/staging', 'r5', 'r3');

    expect(existsSync(file)).toBe(false);
    expect(readdirSync(join(tokens, 'acme'))).toEqual([]);

    await store.remove('other/staging');

    expect(existsSync(join(tokens, 'other'))).toBe(false);

    expect(() => store.read('../escape')).toThrow(/escapes the store folder/);
    expect(() => store.write('../escape', 'r1')).toThrow(/escapes the store folder/);
    expect(() => store.remove('../escape')).toThrow(/escapes the store folder/);
    expect(() => store.read('acme/\0staging')).toThrow(/NUL byte/);
  });
});
