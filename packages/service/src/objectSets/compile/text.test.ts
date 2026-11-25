import { describe, expect, it } from 'vitest';
import { unicodeTables } from './unicodeData.ts';

const HAN = '㐀-䶿一-鿿豈-﫿\u{20000}-\u{3ffff}';
const KATAKANA = '゠-ヺー-ヿㇰ-ㇿｦ-ﾟ';
const JOINERS = ".'’";

const IS_HAN = new RegExp(`[${HAN}]`, 'u');
const IS_KATAKANA = new RegExp(`[${KATAKANA}]`, 'u');
const IS_DIGIT = /\p{Nd}/u;
const IS_SEPARATOR = /[\p{P}\p{S}\p{Z}\p{Cc}\p{Cf}\p{Co}\p{No}\p{Nl}]/u;

function isSeparator(character: string): boolean {
  return character !== '_' && !IS_KATAKANA.test(character) && IS_SEPARATOR.test(character);
}

function lowerCase(character: string): string {
  return character === '\u0130' ? 'i' : character.toLowerCase();
}

function bracketCharacter(point: number): string {
  const character = String.fromCodePoint(point);

  return '[]\\^-'.includes(character) ? `\\${character}` : character;
}

function rangeText(ranges: readonly [number, number][]): string {
  return ranges
    .map(([first, last]) =>
      first === last ? bracketCharacter(first) : `${bracketCharacter(first)}-${bracketCharacter(last)}`,
    )
    .join('');
}

function addRange(ranges: [number, number][], point: number): void {
  const last = ranges.at(-1);

  if (last && last[1] === point - 1) last[1] = point;
  else ranges.push([point, point]);
}

describe('precomputed Unicode tables', () => {
  it('matches the reference Unicode scan across all 1,114,111 code points', () => {
    const expectedByLowerCase = new Map<string, string[]>();
    const separatorRanges: [number, number][] = [];
    const notLetterRanges: [number, number][] = [];
    const digitRanges: [number, number][] = [];

    for (let point = 1; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;

      const character = String.fromCodePoint(point);
      const lower = lowerCase(character);

      if (lower !== character) {
        const group = expectedByLowerCase.get(lower) ?? (lowerCase(lower) === lower ? [lower] : []);

        group.push(character);

        expectedByLowerCase.set(lower, group);
      }

      const separator = isSeparator(character);
      const digit = IS_DIGIT.test(character);

      if (separator && !JOINERS.includes(character)) addRange(separatorRanges, point);

      if (separator || digit || character === '_' || IS_HAN.test(character) || IS_KATAKANA.test(character))
        addRange(notLetterRanges, point);

      if (digit) addRange(digitRanges, point);
    }

    const actual = unicodeTables();

    expect(actual.separator).toBe(rangeText(separatorRanges));
    expect(actual.notLetter).toBe(rangeText(notLetterRanges));
    expect(actual.digit).toBe(rangeText(digitRanges));
    expect(actual.byLowerCase.size).toBe(expectedByLowerCase.size);

    for (const [key, expectedGroup] of expectedByLowerCase) {
      expect(actual.byLowerCase.get(key)).toEqual(expectedGroup);
    }
  });
});
