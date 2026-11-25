import { noOrganizationStep } from './auth/keys.ts';
import { CliError } from './cliError.ts';
import { caught, outcome, type AsyncFallible, type Fallible } from './fallible.ts';
import type { Target } from './targets.ts';

const STDOUT_EXCERPT_LIMIT = 200;

function withContext(body: unknown, step: string | undefined, command: string | undefined): unknown {
  if (step === undefined && command === undefined) return body;

  const base =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : { message: String(body) };

  return {
    ...base,
    ...(step !== undefined && base['step'] === undefined ? { step } : {}),
    ...(command !== undefined && base['command'] === undefined ? { command } : {}),
  };
}

export function errorOutput(error: unknown): unknown {
  const chain: Error[] = [];

  for (
    let at: unknown = error;
    at instanceof Error;
    at = at.cause ?? (at as Error & { originalError?: unknown }).originalError
  )
    chain.push(at);

  const own = chain.find((at) => at instanceof CliError);

  if (own) return withContext(own.body, own.step, own.command);

  const api = chain.find((at) => 'errorName' in at && 'statusCode' in at && at.name !== 'UnknownError');

  if (api) {
    const { errorCode, errorName, errorInstanceId, parameters, statusCode } = api as Error & Record<string, unknown>;

    if (errorName === undefined) return { message: api.message, status: statusCode };

    return { errorCode, errorName, errorInstanceId, parameters };
  }

  return { message: error instanceof Error ? error.message : String(error) };
}

export function withNoOrganizationStep(error: unknown, target: Target): unknown {
  const body = errorOutput(error);

  if ((body as { errorName?: unknown }).errorName !== 'OntologyService:NoOrganization') return error;

  const message = noOrganizationStep(target);

  return new CliError(message, { ...(body as object), message });
}

export const failureOf = (error: unknown): CliError => {
  if (error instanceof CliError) return error;

  const body = errorOutput(error);
  const serviceError = typeof body === 'object' && body !== null && 'errorName' in body;

  return new CliError(error instanceof Error ? error.message : String(error), body, {
    cause: error,
    unexpected: !serviceError,
  });
};

function withStep(error: unknown, step: string): CliError {
  if (error instanceof CliError) {
    if (error.step !== undefined) return error;

    if (!error.unexpected && error.command === undefined) return error;

    return new CliError(error.message, error.body, {
      cause: error.cause,
      step,
      ...(error.command === undefined ? {} : { command: error.command }),
      unexpected: error.unexpected,
    });
  }

  const message = error instanceof Error ? error.message : String(error);

  return new CliError(message, errorOutput(error), { cause: error, step, unexpected: true });
}

export async function* inStep<T>(step: string, run: () => AsyncFallible<T, CliError>): AsyncFallible<T, CliError> {
  const ran = await outcome(run);

  if (ran.ok) return ran.value;

  return yield withStep(ran.error, step);
}

export const formatCommand = (command: string, args: readonly string[]): string => [command, ...args].join(' ');

export function* parseCommandJson(command: string, stdout: string): Fallible<unknown, CliError> {
  const parsed = caught((): unknown => JSON.parse(stdout));

  if (parsed.ok) return parsed.value;

  const trimmed = stdout.trim();

  const detail =
    trimmed === ''
      ? 'printed nothing. The CLI expected JSON.'
      : `did not print JSON: ${JSON.stringify(trimmed.length > STDOUT_EXCERPT_LIMIT ? `${trimmed.slice(0, STDOUT_EXCERPT_LIMIT)}...` : trimmed)}`;

  const message = `${command} ${detail}`;

  return yield new CliError(message, { message }, { cause: parsed.error, command, unexpected: true });
}
