import type { ClientConfig } from '@ericbragas/ontos-service/client-config';
import type { CliError } from '../cliError.ts';
import type { AsyncFallible } from '../fallible.ts';
import type { Io } from '../io.ts';
import type { Flags } from '../main.ts';
import type { Target } from '../targets.ts';

export interface Result {
  readonly output: unknown;
  readonly code: 0 | 1;
  readonly printed?: true;
}

export const ok = (output: unknown): Result => ({ output, code: 0 });

export interface Connection {
  readonly config: ClientConfig;
  readonly token: () => Promise<string>;
}

export interface Context {
  readonly target: Target;
  readonly io: Io;
  readonly flags: Flags;
  readonly version: string;
  readonly run: (args: readonly string[], io: Io) => Promise<number>;
  readonly connection: () => AsyncFallible<Connection, CliError>;
}

type Flag = keyof Flags;

export interface CommandSpec {
  readonly local?: undefined;
  readonly flags: readonly Flag[];
  readonly minArgs: number;
  readonly args: number;
  readonly usage: string;
  readonly noTestUser?: true;
  readonly run: (context: Context, args: readonly string[]) => AsyncFallible<Result, CliError>;
}

export interface LocalCommandSpec extends Omit<CommandSpec, 'run' | 'local'> {
  readonly local: true;
  readonly run: (io: Io, args: readonly string[], flags: Flags, version: string) => AsyncFallible<Result, CliError>;
}
