import type { KnownCaller } from '../auth/index.ts';
import type { Sql } from '../db/index.ts';
import type {
  CompiledActionType,
  CompiledDerivedProperty,
  CompiledFunction,
  CompiledObjectType,
} from '../ontology/index.ts';
import { BRANDS, type ApiName, type SqlTemplate, type TracedUser } from './brandTypes.ts';

const MAX_TEMPLATE = 4096;

const DDL_VERBS: ReadonlySet<string> = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'COMMENT', 'GRANT', 'REVOKE']);

const DDL_OBJECT_WORDS: ReadonlySet<string> = new Set([
  'OR',
  'REPLACE',
  'UNIQUE',
  'TEMP',
  'TEMPORARY',
  'UNLOGGED',
  'MATERIALIZED',
  'TABLE',
  'INDEX',
  'SCHEMA',
  'VIEW',
  'FUNCTION',
  'PROCEDURE',
  'TRIGGER',
  'TYPE',
  'SEQUENCE',
  'EXTENSION',
  'ROLE',
  'POLICY',
  'DOMAIN',
]);

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\w$]/.test(char);
const isDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '9';

function quotedEnd(text: string, start: number, quote: string, backslash: boolean): number {
  let index = start + 1;

  while (index < text.length) {
    const char = text[index];

    if (backslash && char === '\\') index += 2;
    else if (char === quote && text[index + 1] === quote) index += 2;
    else if (char === quote) return index + 1;
    else index += 1;
  }

  return text.length;
}

function withoutValues(text: string): string {
  let out = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index] ?? '';
    const next = text[index + 1];

    if (char === '-' && next === '-') {
      const end = text.indexOf('\n', index);

      index = end === -1 ? text.length : end;
    } else if (char === '/' && next === '*') {
      let depth = 0;

      do {
        const mark = text.slice(index, index + 2);

        depth += mark === '/*' ? 1 : mark === '*/' ? -1 : 0;

        index += mark === '/*' || mark === '*/' ? 2 : 1;
      } while (depth > 0 && index < text.length);
    } else if (char === '"') {
      const end = quotedEnd(text, index, '"', false);

      out += text.slice(index, end);

      index = end;
    } else if (char === "'") {
      const prefix = /(?:^|[^\w$])([EeBbXxNn]|[Uu]&)$/.exec(out)?.[1] ?? '';
      const escape = prefix === 'E' || prefix === 'e';

      out = `${out.slice(0, out.length - prefix.length)}?`;

      index = quotedEnd(text, index, "'", escape);
    } else if (char === '$' && !isWordChar(text[index - 1])) {
      const tag = /^\$(?:[A-Za-z_][\w]*)?\$/.exec(text.slice(index))?.[0];

      if (tag === undefined) {
        const end = /^\$\d*/.exec(text.slice(index))?.[0].length ?? 1;

        out += text.slice(index, index + end);

        index += end;
      } else {
        const close = text.indexOf(tag, index + tag.length);

        out += '?';

        index = close === -1 ? text.length : close + tag.length;
      }
    } else if ((isDigit(char) || (char === '.' && isDigit(next))) && !isWordChar(text[index - 1])) {
      const number =
        /^(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)/.exec(
          text.slice(index),
        )?.[0] ?? char;

      out += '?';

      index += number.length;
    } else {
      out += char;

      index += 1;
    }
  }

  return out;
}

function ddlVerb(text: string): string | undefined {
  const words = text
    .trim()
    .split(/\s+/)
    .map((word) => word.toUpperCase());

  const [verb, ...rest] = words;

  if (verb === undefined || !DDL_VERBS.has(verb)) return undefined;

  if (verb !== 'CREATE' && verb !== 'ALTER' && verb !== 'DROP') return verb;

  const objects = [];

  for (const word of rest) {
    if (!DDL_OBJECT_WORDS.has(word)) break;

    objects.push(word);
  }

  return [verb, ...objects].join(' ');
}

export function sqlTemplate(statement: Sql): SqlTemplate {
  const text = withoutValues(statement.text);

  return new BRANDS.sqlTemplate(ddlVerb(text) ?? text.slice(0, MAX_TEMPLATE));
}

export function apiNameOf(
  entity: CompiledObjectType | CompiledActionType | CompiledDerivedProperty | CompiledFunction,
): ApiName {
  return new BRANDS.apiName(entity.apiName);
}

export function tracedUser(caller: KnownCaller): TracedUser {
  return new BRANDS.tracedUser(caller.user);
}
