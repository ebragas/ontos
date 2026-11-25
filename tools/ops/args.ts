import { parseArgs } from 'node:util';
import { caught } from '../../packages/service/src/errors/fallible.ts';

interface WriteArgs {
  readonly positionals: readonly string[];
  readonly write: boolean;
}

interface ConfirmFlag {
  readonly flag: string;
  readonly noun: string;
}

export const CONFIRM_RID: ConfirmFlag = { flag: 'confirm-rid', noun: 'RID' };

export function parseWriteArgs(
  args: readonly string[],
  usage: string,
  targetAt: number,
  confirms: ReadonlyMap<string, ConfirmFlag>,
): WriteArgs | string {
  const flags = [...new Set([...confirms.values()].map((confirm) => confirm.flag))];

  const options: Record<string, { type: 'boolean' | 'string' }> = {
    write: { type: 'boolean' },
    ...Object.fromEntries(flags.map((flag) => [flag, { type: 'string' as const }])),
  };

  const ran = caught(() => parseArgs({ args: [...args], allowPositionals: true, strict: true, tokens: true, options }));

  if (!ran.ok) return `${(ran.error as Error).message}\n${usage}`;

  const parsed = ran.value;
  const names = parsed.tokens.flatMap((token) => (token.kind === 'option' ? [token.name] : []));
  const twice = names.find((name, index) => names.indexOf(name) !== index);

  if (twice) return `The flag --${twice} is given 2 times.\n${usage}`;

  const [command] = parsed.positionals;
  const confirm = command === undefined ? undefined : confirms.get(command);

  if (!confirm) return usage;

  const other = flags.find((flag) => flag !== confirm.flag && parsed.values[flag] !== undefined);

  if (other) return `The flag --${other} is not a flag of ${command}.\n${usage}`;

  const target = parsed.positionals[targetAt];
  const write = parsed.values['write'] === true;
  const confirmed = parsed.values[confirm.flag];
  const value = typeof confirmed === 'string' ? confirmed : undefined;

  if (write !== (value !== undefined))
    return `A write needs both --write and --${confirm.flag} ${target ?? `<${confirm.noun.toLowerCase()}>`}.`;

  if (value !== undefined && value !== target)
    return `--${confirm.flag} ${value} is not the ${confirm.noun} of the command, ${target}.`;

  return { positionals: parsed.positionals, write };
}

export function refuse(message: string): number {
  console.error(message);

  return 1;
}

const HINTS_BY_CODE: ReadonlyMap<string, string> = new Map([
  ['ERR_INVALID_URL', 'A database URL is not a URL.'],
  ['28P01', 'The password or the role is wrong.'],
  ['28000', 'The role cannot sign in to this database.'],
  ['3D000', 'The database of the URL does not exist.'],
  ['ECONNREFUSED', 'No server listens on the host and port of the URL.'],
  ['ENOTFOUND', 'The host of the URL has no DNS record.'],
  ['ETIMEDOUT', 'The host did not answer in time.'],
  ['42501', 'The role of the URL has no right to do this.'],
  ['57014', 'The statement passed its time limit. Run the command again.'],
]);

const NO_SSL_HINT = {
  message: 'The server does not support SSL connections',
  hint: 'The server does not accept SSL. Use a TLS-enabled or direct PostgreSQL connection string.',
} as const;

const WORD = /^[A-Za-z0-9_]{1,64}$/;

const NO_CODE = 'The command failed with no error code.';

function lineOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;

  if (typeof code === 'string') {
    if (!WORD.test(code)) return 'The command failed with an error code that is not 1 word.';

    return [`The command failed with the error code ${code}.`, HINTS_BY_CODE.get(code)].filter(Boolean).join(' ');
  }

  const name: unknown =
    typeof error === 'object' && error !== null ? Object.getPrototypeOf(error)?.constructor?.name : undefined;

  if (typeof name !== 'string' || !WORD.test(name)) return NO_CODE;

  const noSsl = (error as { message?: unknown }).message === NO_SSL_HINT.message;

  return [NO_CODE, `The error class is ${name}.`, noSsl && NO_SSL_HINT.hint].filter(Boolean).join(' ');
}

export function failureLine(error: unknown): string {
  const line = caught(() => lineOf(error));

  return line.ok ? line.value : NO_CODE;
}

export async function exitCodeOf(run: () => Promise<number>): Promise<number> {
  const ran = await caught(run);

  return ran.ok ? ran.value : refuse(failureLine(ran.error));
}
