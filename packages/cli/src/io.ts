import { constants } from 'node:os';
import type { CliError } from './cliError.ts';
import type { AsyncFallible } from './fallible.ts';
import type { TokenStore } from './index.ts';

export type { TokenStore };

export interface Registry {
  find(name: string, ontologyHash: string, cwd: string, registry: string): AsyncFallible<string | undefined, CliError>;
  publish(folder: string, cwd: string): AsyncFallible<void, CliError>;
  tag(name: string, version: string, tag: string, cwd: string, registry: string): AsyncFallible<void, CliError>;
}

export type Variables = Readonly<Record<string, string | undefined>>;

export interface Io {
  readonly cwd: string;
  readonly env: Variables;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly fetch: typeof fetch;
  readonly tokenStore: TokenStore;
  readonly registry: Registry;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onStop: (stop: () => Promise<void>) => () => void;
  readonly isTty: boolean;
}

interface StopTarget {
  once(signal: 'SIGINT' | 'SIGTERM', listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: (signal: NodeJS.Signals) => void): unknown;
  exit(code: number): void;
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export const onStop =
  (target: StopTarget) =>
  (stop: () => Promise<void>): (() => void) => {
    const remove = (): void => {
      for (const name of STOP_SIGNALS) target.off(name, listener);
    };

    const listener = (signal: NodeJS.Signals): void => {
      remove();

      void stop().finally(() => target.exit(128 + constants.signals[signal]));
    };

    for (const name of STOP_SIGNALS) target.once(name, listener);

    return remove;
  };

export const warn = (io: Pick<Io, 'stderr'>, text: string): void => io.stderr(`${JSON.stringify({ warning: text })}\n`);
