import { errorOutput } from '../errors.ts';
import type { Io } from '../io.ts';
import type { HelpCommand } from './help.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatInit(output: unknown): string {
  if (!isRecord(output) || typeof output['directory'] !== 'string' || !Array.isArray(output['files'])) {
    return `${JSON.stringify(output, null, 2)}\n`;
  }

  const files = (output['files'] as unknown[]).map((file) => `  - ${String(file)}`);

  return [
    `Initialized Ontos project in ${output['directory']}`,
    ...files,
    '',
    'Next steps:',
    '  1. Install dependencies (npm install)',
    '  2. Generate the SDK (npm run generate-osdk)',
    '  3. Start local Postgres and run: DATABASE_URL=... npm run dev',
    '',
  ].join('\n');
}

function formatGenerateOsdk(output: unknown): string {
  if (!isRecord(output) || typeof output['osdkOutput'] !== 'string') {
    return `${JSON.stringify(output, null, 2)}\n`;
  }

  const passes = typeof output['passes'] === 'number' ? output['passes'] : 1;

  return `Generated Ontology SDK in ${output['osdkOutput']} (${passes} ${passes === 1 ? 'pass' : 'passes'}).\n`;
}

function formatObjects(output: unknown): string {
  if (!isRecord(output) || !Array.isArray(output['data'])) {
    return `${JSON.stringify(output, null, 2)}\n`;
  }

  const rows = output['data'] as unknown[];

  if (rows.length === 0) return 'No objects found.\n';

  const lines = [`${rows.length} object${rows.length === 1 ? '' : 's'}:`];

  for (const row of rows) {
    lines.push(`  ${JSON.stringify(row)}`);
  }

  if (typeof output['nextPageToken'] === 'string' && output['nextPageToken'] !== '') {
    lines.push(`Next page token: ${output['nextPageToken']}`);
  }

  return `${lines.join('\n')}\n`;
}

function formatSimpleCommand(command: HelpCommand | 'version', output: unknown): string | undefined {
  if (command === 'version' && isRecord(output) && typeof output['version'] === 'string') {
    return `ontos ${output['version']}\n`;
  }

  if (command === 'init') return formatInit(output);

  if (command === 'generate-osdk') return formatGenerateOsdk(output);

  if (command === 'login' && isRecord(output) && typeof output['loggedIn'] === 'string') {
    return `Logged in (${output['loggedIn']}).\n`;
  }

  if (command === 'logout' && isRecord(output) && typeof output['loggedOut'] === 'string') {
    return `Logged out (${output['loggedOut']}).\n`;
  }

  if (
    command === 'install' &&
    isRecord(output) &&
    typeof output['apiName'] === 'string' &&
    typeof output['rid'] === 'string'
  ) {
    return `Installed ${output['apiName']} (${output['rid']}).\n`;
  }

  if (command === 'objects') return formatObjects(output);

  return undefined;
}

export function formatOutput(
  command: HelpCommand | 'version',
  output: unknown,
  io: Pick<Io, 'isTty'>,
  json: boolean,
): string {
  if (json || !io.isTty) return `${JSON.stringify(output)}\n`;

  return formatSimpleCommand(command, output) ?? `${JSON.stringify(output, null, 2)}\n`;
}

export function formatError(error: unknown, io: Pick<Io, 'isTty'>, json: boolean): string {
  const body = errorOutput(error);

  if (json || !io.isTty) return `${JSON.stringify(body)}\n`;

  if (isRecord(body) && typeof body['message'] === 'string') {
    const code = typeof body['errorName'] === 'string' ? ` (${body['errorName']})` : '';

    return `Error${code}: ${body['message']}\n`;
  }

  if (isRecord(body) && typeof body['errorName'] === 'string') {
    const detail = body['parameters'] !== undefined ? ` ${JSON.stringify(body['parameters'])}` : '';

    return `Error: ${body['errorName']}${detail}\n`;
  }

  return `Error: ${JSON.stringify(body)}\n`;
}
