#!/usr/bin/env node

import { onStop, type Io as FullIo } from './io.ts';
import { errorOutput } from './errors.ts';
import { caught, settle, type Fallible } from './fallible.ts';
import { run as runCli } from './main.ts';
import { npmRegistry } from './sdk/sdkPackage.ts';
import { configTokenStore } from './auth/store.ts';

/** The stored refresh tokens: 1 for each app and environment, by the key `<app>/<environment>`, and 1 for the test user, `<app>/<environment>-test-user`. */
export interface TokenStore {
  read(key: string): Promise<string | undefined>;
  /** With `expected`, writes only when the key still holds `expected`, so a missing key stays missing. A refresh passes the token that it read. */
  write(key: string, token: string, expected?: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The things outside the CLI that a command touches. A missing field gets the value that the `ontos` command uses. */
export interface Io {
  /** The folder that the command runs in. The default is `process.cwd()`. */
  readonly cwd?: string;
  /** The variables of the shell. The default is `process.env`. The CLI does not change them. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Takes the output. The default writes to `process.stdout`. */
  readonly stdout?: (text: string) => void;
  /** Takes the error output. The default writes to `process.stderr`. */
  readonly stderr?: (text: string) => void;
  /** The default is the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Waits, such as between 2 tries of a refresh. The default is a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The default is the token files of the user's config folder, from `XDG_CONFIG_HOME` of `env`. */
  readonly tokenStore?: TokenStore;
  /** Whether stdout is an interactive terminal. Defaults to `process.stdout.isTTY` when using the default stdout, and `false` otherwise. */
  readonly isTty?: boolean;
}

/** Runs 1 command line, as the `ontos` command does. Gives the exit code: 0 on success, 1 on an error. */
export async function run(args: readonly string[], io: Io = {}): Promise<number> {
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  const full = settle(defaults(io, stderr));

  if (!full.ok) {
    stderr(`${JSON.stringify(errorOutput(full.error))}\n`);

    return 1;
  }

  return runCli(args, full.value);
}

function* defaults(io: Io, stderr: (text: string) => void): Fallible<FullIo, unknown> {
  const first = caught(() => ({
    env: io.env ?? process.env,
    cwd: io.cwd ?? process.cwd(),
    stdout: io.stdout ?? ((text: string) => process.stdout.write(text)),
    fetch: io.fetch ?? globalThis.fetch,
    tokenStore: io.tokenStore,
    isTty: io.isTty ?? (io.stdout === undefined && Boolean(process.stdout.isTTY)),
  }));

  if (!first.ok) return yield first.error;

  const tokenStore = first.value.tokenStore ?? (yield* configTokenStore(first.value.env));

  const rest = caught(() => ({
    registry: npmRegistry,
    sleep: io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    onStop: onStop(process),
  }));

  if (!rest.ok) return yield rest.error;

  return { ...first.value, stderr, tokenStore, ...rest.value };
}

if (import.meta.main) {
  Error.stackTraceLimit = 30;

  const ran = await caught(() => run(process.argv.slice(2)));

  if (!ran.ok) process.stderr.write(`${JSON.stringify(errorOutput(ran.error))}\n`);

  process.exitCode = ran.ok ? ran.value : 1;
}
