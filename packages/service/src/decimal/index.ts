import Big, { type BigConstructor } from 'big.js';
import { invariant } from '../errors/index.ts';

const isConstructor = (value: unknown): value is BigConstructor => typeof value === 'function';

invariant(isConstructor(Big), 'big.js gave no constructor as its default export.');

const PrivateBig = Big();

const MAX_LENGTH = 1_000;
const MAX_EXPONENT = 1_000;
const GRAMMAR = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/;

const read = (text: string) => new PrivateBig(text.startsWith('+') ? text.slice(1) : text);

export interface DecimalFit {
  readonly precision: number;
  readonly scale: number;
}

export type DecimalParse =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly refusal: 'notDecimal' | 'doesNotFit' };

export function parseDecimal(value: unknown, fit?: DecimalFit): DecimalParse {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;

  if (typeof text !== 'string' || text.length > MAX_LENGTH) return { ok: false, refusal: 'notDecimal' };

  const match = GRAMMAR.exec(text);

  if (match === null || Math.abs(Number(match[1] ?? 0)) > MAX_EXPONENT) return { ok: false, refusal: 'notDecimal' };

  const big = read(text);
  const zero = big.c[0] === 0;

  if (fit !== undefined && !zero) {
    const fraction = Math.max(0, big.c.length - 1 - big.e);
    const whole = big.e + 1;

    if (fraction > fit.scale || whole > fit.precision - fit.scale) return { ok: false, refusal: 'doesNotFit' };
  }

  return { ok: true, text: big.toFixed(fit?.scale) };
}

export function compareDecimal(left: string, right: string): -1 | 0 | 1 {
  return read(left).cmp(read(right));
}
