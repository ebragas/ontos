import { invariant } from '../../errors/index.ts';
import { unicodeTables } from './unicodeData.ts';

const HAN = '㐀-䶿一-鿿豈-﫿\u{20000}-\u{3ffff}';
const KATAKANA = '゠-ヺー-ヿㇰ-ㇿｦ-ﾟ';
const JOINERS = ".'’";

const IS_HAN = new RegExp(`[${HAN}]`, 'u');
const IS_KATAKANA = new RegExp(`[${KATAKANA}]`, 'u');
const IS_LETTER = /[\p{L}\p{M}]/u;
const IS_DIGIT = /\p{Nd}/u;
const IS_SEPARATOR = /[\p{P}\p{S}\p{Z}\p{Cc}\p{Cf}\p{Co}\p{No}\p{Nl}]/u;

const OPERATOR = /[\\^$.|?*+()[\]{}]/u;

type WordKind = 'han' | 'katakana' | 'other';

export interface Word {
  readonly kind: WordKind;
  readonly characters: readonly string[];
}

interface TextTerm {
  readonly filter: string;
  readonly pattern: string;
}

interface TextMatch {
  readonly terms: readonly TextTerm[];
  readonly join: 'any' | 'all';
}

export function textMatch(query: string, words: readonly Word[]): TextMatch {
  switch (query) {
    case 'containsAnyTerm':
      return {
        terms: words.map((word) => ({
          filter: letters(word),
          pattern: `${before(word)}${letters(word)}${after(word)}`,
        })),
        join: 'any',
      };
    case 'containsAllTerms':
      return {
        terms: words.map((word) => ({
          filter: letters(word),
          pattern: `${before(word)}${letters(word)}${after(word)}`,
        })),
        join: 'all',
      };
    case 'containsAllTermsInOrder':
      return {
        terms:
          words.length === 0
            ? []
            : [{ filter: inOrderFilter(words), pattern: `${inOrder(words)}${after(lastOf(words))}` }],
        join: 'all',
      };
    case 'startsWith':
    case 'containsAllTermsInOrderPrefixLastTerm':
      return {
        terms: words.length === 0 ? [] : [{ filter: inOrderFilter(words), pattern: inOrder(words) }],
        join: 'all',
      };
    default:
      invariant(false, `${query} is not a text search query of V1.`);
  }
}

function isLetter(character: string): boolean {
  return IS_LETTER.test(character) && !IS_HAN.test(character) && !IS_KATAKANA.test(character);
}

function isDigit(character: string): boolean {
  return IS_DIGIT.test(character);
}

function isSeparator(character: string): boolean {
  return character !== '_' && !IS_KATAKANA.test(character) && IS_SEPARATOR.test(character);
}

function joins(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;

  return (isLetter(left) && isLetter(right)) || (isDigit(left) && isDigit(right));
}

export function wordsOf(value: string): Word[] {
  const characters = Array.from(value);
  const words: Word[] = [];
  let run: { kind: WordKind; characters: string[] } | undefined;

  const add = (kind: 'katakana' | 'other', character: string) => {
    if (run?.kind !== kind) {
      run = { kind, characters: [] };

      words.push(run);
    }

    run.characters.push(character);
  };

  characters.forEach((character, index) => {
    if (IS_HAN.test(character)) {
      run = undefined;

      words.push({ kind: 'han', characters: [character] });
    } else if (IS_KATAKANA.test(character)) {
      add('katakana', character);
    } else if (!isSeparator(character)) {
      add('other', character);
    } else if (
      JOINERS.includes(character) &&
      run?.kind === 'other' &&
      joins(run.characters.at(-1), characters[index + 1])
    ) {
      run.characters.push(character);
    } else {
      run = undefined;
    }
  });

  return words.filter(
    (word) => word.kind !== 'other' || word.characters.some((character) => isLetter(character) || isDigit(character)),
  );
}

function inOrder(words: readonly Word[]): string {
  const first = words[0];

  if (!first) return '';

  let pattern = `${before(first)}${letters(first)}`;

  for (let index = 1; index < words.length; index += 1) {
    const left = words[index - 1] as Word;
    const right = words[index] as Word;

    pattern += `${gap(left, right)}${letters(right)}`;
  }

  return pattern;
}

function inOrderFilter(words: readonly Word[]): string {
  return words.map(letters).join('.*');
}

function lastOf(words: readonly Word[]): Word {
  return words[words.length - 1] as Word;
}

function letters(word: Word): string {
  return word.characters.map(letter).join('');
}

function letter(character: string): string {
  const cases = unicodeTables().byLowerCase.get(lowerCase(character));

  if (cases && cases.length > 1) return `[${cases.join('')}]`;

  return OPERATOR.test(character) ? `\\${character}` : character;
}

function lowerCase(character: string): string {
  return character === '\u0130' ? 'i' : character.toLowerCase();
}

function before(word: Word): string {
  return edge(word, word.characters[0] ?? '', 'start');
}

function after(word: Word): string {
  return edge(word, word.characters.at(-1) ?? '', 'end');
}

function edge(word: Word, character: string, side: 'start' | 'end'): string {
  const anchor = side === 'start' ? '^' : '$';

  switch (word.kind) {
    case 'han':
      return '';
    case 'katakana':
      return `(?:${anchor}|[^${KATAKANA}])`;
    case 'other': {
      const { separator, notLetter, digit } = unicodeTables();
      const other = isLetter(character) ? `[${notLetter}]` : isDigit(character) ? `[^${digit}]` : undefined;

      if (other === undefined) return `(?:${anchor}|[${separator}${JOINERS}${HAN}${KATAKANA}])`;

      const joiner = side === 'start' ? `(?:^|${other})[${JOINERS}]` : `[${JOINERS}](?:$|${other})`;

      return `(?:${anchor}|[${separator}${HAN}${KATAKANA}]|${joiner})`;
    }
  }
}

function gap(left: Word, right: Word): string {
  const { separator } = unicodeTables();
  const between = `[${separator}${JOINERS}]`;
  const runs = `${between}+(?:_+${between}+)*`;

  if (left.kind === 'other' && right.kind === 'other') {
    if (!joins(left.characters.at(-1), right.characters[0])) return runs;

    return `(?:[${separator}]|${between}{2,}|${between}+(?:_+${between}+)+)`;
  }

  if (left.kind !== 'other' && right.kind !== 'other')
    return `(?:${between}|_)${left.kind === right.kind && left.kind === 'katakana' ? '+' : '*'}`;

  return `(?:${left.kind === 'other' ? `${runs}_*` : `_*${runs}`})?`;
}
