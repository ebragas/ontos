import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { formatError, formatOutput } from './commands/format.ts';
import { commandHelp, globalHelp } from './commands/help.ts';
import { COMMANDS, runCommand, type Command } from './commands/index.ts';
import { CliError } from './cliError.ts';
import { errorOutput } from './errors.ts';
import { answerOf, caught, outcome, type AsyncFallible } from './fallible.ts';
import type { Io } from './io.ts';

const options = {
  app: { type: 'string' },
  env: { type: 'string' },
  url: { type: 'string' },
  'test-user': { type: 'boolean' },
  org: { type: 'string' },
  ontology: { type: 'string' },
  'api-name': { type: 'string' },
  'display-name': { type: 'string' },
  where: { type: 'string' },
  'order-by': { type: 'string' },
  select: { type: 'string' },
  'group-by': { type: 'string' },
  link: { type: 'string' },
  'page-size': { type: 'string' },
  'page-token': { type: 'string' },
  parameters: { type: 'string' },
  'validate-only': { type: 'boolean' },
  'skip-sdk-package': { type: 'boolean' },
  local: { type: 'boolean' },
  base: { type: 'string' },
  force: { type: 'boolean' },
  port: { type: 'string' },
  host: { type: 'string' },
  'database-url': { type: 'string' },
  token: { type: 'string' },
  'product-rid': { type: 'string' },
  json: { type: 'boolean' },
  version: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

export type Flags = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>['values'];

function version(): string {
  return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

const refused = (error: unknown): CliError =>
  new CliError(error instanceof Error ? error.message : String(error), errorOutput(error));

const usageMessage = (): string => `Usage: ontos <${Object.keys(COMMANDS).join(' | ')}> [options], or ontos --version`;

export async function run(args: readonly string[], io: Io): Promise<number> {
  const ran = await outcome(() => execute(args, io));

  if (ran.ok) return ran.value;

  io.stderr(formatError(ran.error, io, args.includes('--json')));

  return 1;
}

async function* execute(args: readonly string[], io: Io): AsyncFallible<number, CliError> {
  const parsed = caught(() => parseArgs({ args: [...args], options, allowPositionals: true, strict: true }));

  if (!parsed.ok) return yield refused(parsed.error);

  const { values: flags, positionals } = parsed.value;
  const [command, ...rest] = positionals;

  if (command === 'help') {
    if (rest.length === 0) {
      io.stdout(globalHelp());

      return 0;
    }

    if (rest.length === 1 && Object.hasOwn(COMMANDS, rest[0] ?? '')) {
      io.stdout(commandHelp(rest[0] as Command));

      return 0;
    }

    return yield new CliError(usageMessage());
  }

  if (flags.help) {
    if (command === undefined) {
      io.stdout(globalHelp());

      return 0;
    }

    if (Object.hasOwn(COMMANDS, command)) {
      io.stdout(commandHelp(command as Command));

      return 0;
    }

    return yield new CliError(usageMessage());
  }

  if (flags.version) {
    const extra = args.filter((arg) => arg !== '--version' && arg !== '--json');

    if (extra.length > 0) return yield new CliError('Usage: ontos --version, with no command or other flag.');

    io.stdout(formatOutput('version', { version: version() }, io, flags.json === true));

    return 0;
  }

  if (!Object.hasOwn(COMMANDS, command ?? '')) {
    return yield new CliError(usageMessage());
  }

  const result = yield* answerOf(runCommand(command as Command, rest, flags, io, version(), run));

  if (!result.printed) io.stdout(formatOutput(command as Command, result.output, io, flags.json === true));

  return result.code;
}
