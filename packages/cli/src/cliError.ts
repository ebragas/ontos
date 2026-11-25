import { attempt, caught, type AsyncFallible, type Result } from './fallible.ts';
import { failureOf } from './errors.ts';

interface CliErrorOptions extends ErrorOptions {
  readonly step?: string;
  readonly command?: string;
  readonly unexpected?: boolean;
}

export class CliError extends Error {
  readonly body: unknown;
  readonly step: string | undefined;
  readonly command: string | undefined;
  readonly unexpected: boolean;

  constructor(message: string, body: unknown = { message }, options?: CliErrorOptions) {
    super(message, options);

    this.body = body;
    this.step = options?.step;
    this.command = options?.command;
    this.unexpected = options?.unexpected ?? false;
  }
}

export async function* shared<T>(pending: Promise<Result<T, CliError>>): AsyncFallible<T, CliError> {
  const result = yield* attempt(() => pending, failureOf);

  if (!result.ok) return yield result.error;

  return result.value;
}

export function errorBodyOf(status: number, text: string): unknown {
  const parsed = caught((): unknown => JSON.parse(text));

  return parsed.ok ? parsed.value : { status, message: text };
}

export async function* errorBody(response: Response): AsyncFallible<unknown, CliError> {
  const text = yield* attempt(() => response.text(), failureOf);

  return errorBodyOf(response.status, text);
}
