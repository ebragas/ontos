import { describe, expect, it } from 'vitest';
import type {
  CompiledConstraint,
  CompiledValueType,
  JsonValue,
  ValueTypeBase,
  ValueTypeRule,
} from '../ontology/index.ts';
import { compareScalar, constraintText, regexOf, valueTypeCheck } from './index.ts';

const constraints = 'ontology/object-link-types/value-types#constraints';

const constraint = (rule: ValueTypeRule, failureMessage?: string): CompiledConstraint => ({ rule, failureMessage });

function valueType(baseType: ValueTypeBase, ...list: CompiledConstraint[]): CompiledValueType {
  return {
    apiName: 'v',
    rid: 'ri.v',
    version: '1.0.0',
    status: 'active',
    displayName: 'V',
    description: undefined,
    baseType,
    constraints: list,
  };
}

const failedRule = (type: CompiledValueType, value: JsonValue) => valueTypeCheck(type)(value)?.rule;

describe('valueTypeCheck', () => {
  it(`${constraints}: an enum gives the constraint of a value outside its options, for each base type`, () => {
    const cases: [ValueTypeBase['kind'], JsonValue[], JsonValue, JsonValue][] = [
      ['string', ['open', 'done'], 'done', 'closed'],
      ['boolean', [true], true, false],
      ['integer', [1, 2], 2, 3],
      ['double', [1.5], 1.5, 1.6],
      ['decimal', ['1.5'], '1.50', '1.51'],
    ];

    for (const [kind, options, good, bad] of cases) {
      const rule: ValueTypeRule = { kind: 'enum', options: options as (string | number | boolean)[] };
      const type = valueType({ kind } as ValueTypeBase, constraint(rule));

      expect(failedRule(type, good)).toBeUndefined();
      expect(failedRule(type, bad)).toBe(rule);
    }
  });

  it(`${constraints}: a range includes both bounds, for each base type`, () => {
    const cases: [ValueTypeBase['kind'], JsonValue, JsonValue, JsonValue, JsonValue, JsonValue][] = [
      ['integer', 0, 100, 100, -1, 101],
      ['double', 0.5, 1.5, 1.5, 0.4, 1.6],
      ['decimal', '0.5', '1.5', '1.50', '0.49', '1.51'],
      ['date', '2026-01-01', '2026-12-31', '2026-12-31', '2025-12-31', '2027-01-01'],
      [
        'timestamp',
        '2026-01-01T00:00:00Z',
        '2026-01-02T00:00:00Z',
        '2026-01-02T01:00:00+01:00',
        '2025-12-31T23:59:59Z',
        '2026-01-02T00:00:01Z',
      ],
    ];

    for (const [kind, minimum, maximum, atMaximum, below, above] of cases) {
      const rule: ValueTypeRule = { kind: 'range', minimum: minimum as string, maximum: maximum as string };
      const type = valueType({ kind } as ValueTypeBase, constraint(rule));

      expect(failedRule(type, minimum)).toBeUndefined();
      expect(failedRule(type, atMaximum)).toBeUndefined();
      expect(failedRule(type, below)).toBe(rule);
      expect(failedRule(type, above)).toBe(rule);
    }
  });

  it(`${constraints}: a range with 1 bound checks only that bound`, () => {
    const atLeast = valueType({ kind: 'integer' }, constraint({ kind: 'range', minimum: 5 }));
    const atMost = valueType({ kind: 'integer' }, constraint({ kind: 'range', maximum: 5 }));

    expect([failedRule(atLeast, 4) !== undefined, failedRule(atLeast, 1e9) !== undefined]).toEqual([true, false]);
    expect([failedRule(atMost, 6) !== undefined, failedRule(atMost, -1e9) !== undefined]).toEqual([true, false]);
  });

  it(`${constraints}: a length counts UTF-16 units and includes both bounds`, () => {
    const type = valueType({ kind: 'string' }, constraint({ kind: 'length', minimum: 2, maximum: 3 }));

    expect(failedRule(type, 'a')).toBeDefined();
    expect(failedRule(type, 'ab')).toBeUndefined();
    expect(failedRule(type, 'abc')).toBeUndefined();
    expect(failedRule(type, 'abcd')).toBeDefined();
    expect(failedRule(type, '\u{1F600}')).toBeUndefined();
    expect(failedRule(type, '\u{1F600}a')).toBeUndefined();
    expect(failedRule(type, '\u{1F600}ab')).toBeDefined();
  });

  it(`${constraints}: a regex matches in full by default and in part with usePartialMatch`, () => {
    const full = valueType(
      { kind: 'string' },
      constraint({ kind: 'regex', pattern: '[A-Z]{3}-\\d+', partialMatch: false }),
    );

    const partial = valueType(
      { kind: 'string' },
      constraint({ kind: 'regex', pattern: '[A-Z]{3}', partialMatch: true }),
    );

    expect(failedRule(full, 'ABC-12')).toBeUndefined();
    expect(failedRule(full, 'xABC-12')).toBeDefined();
    expect(failedRule(full, 'ABC-12x')).toBeDefined();
    expect(failedRule(partial, 'xxABCxx')).toBeUndefined();
    expect(failedRule(partial, 'abc')).toBeDefined();
  });

  it(`${constraints}: a UUID is 8-4-4-4-12 hex digits in any case`, () => {
    const type = valueType({ kind: 'string' }, constraint({ kind: 'uuid' }));

    expect(failedRule(type, '123e4567-e89b-12d3-a456-426614174000')).toBeUndefined();
    expect(failedRule(type, '123E4567-E89B-12D3-A456-426614174000')).toBeUndefined();

    for (const bad of [
      '123e4567e89b12d3a456426614174000',
      '123e4567-e89b-12d3-a456-42661417400',
      '123e4567-e89b-12d3-a456-42661417400g',
      ' 123e4567-e89b-12d3-a456-426614174000',
    ]) {
      expect(failedRule(type, bad)).toBeDefined();
    }
  });

  it(`${constraints}: an array checks its size, its unique elements, and a constraint on each element`, () => {
    const element: ValueTypeRule = { kind: 'enum', options: ['a', 'b', 'c'] };

    const type = valueType(
      { kind: 'array', element: 'string' },
      constraint({ kind: 'array', minimumSize: 1, maximumSize: 2, uniqueValues: true, element }),
    );

    expect(failedRule(type, ['a'])).toBeUndefined();
    expect(failedRule(type, ['a', 'b'])).toBeUndefined();
    expect(failedRule(type, [])).toBeDefined();
    expect(failedRule(type, ['a', 'b', 'c'])).toBeDefined();
    expect(failedRule(type, ['a', 'a'])).toBeDefined();
    expect(failedRule(type, ['a', 'z'])).toBeDefined();
    expect(failedRule(type, 'a')).toBeDefined();
  });

  it(`${constraints}: an array with no unique rule allows a repeat, and the unique rule compares a Decimal and a Timestamp by value`, () => {
    const free = valueType({ kind: 'array', element: 'string' }, constraint({ kind: 'array', uniqueValues: false }));

    expect(failedRule(free, ['a', 'a'])).toBeUndefined();

    const decimals = valueType(
      { kind: 'array', element: 'decimal' },
      constraint({ kind: 'array', uniqueValues: true }),
    );

    expect(failedRule(decimals, ['1.5', '1.50'])).toBeDefined();
    expect(failedRule(decimals, ['1.5', '1.51'])).toBeUndefined();

    const stamps = valueType(
      { kind: 'array', element: 'timestamp' },
      constraint({ kind: 'array', uniqueValues: true }),
    );

    expect(failedRule(stamps, ['2026-01-01T01:00:00+01:00', '2026-01-01T00:00:00Z'])).toBeDefined();
    expect(failedRule(stamps, ['2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z'])).toBeUndefined();
  });

  it(`${constraints}: the first failed constraint of the list gives the error, in order`, () => {
    const length = constraint({ kind: 'length', minimum: 6, maximum: 12 }, 'Too short or long.');

    const regex = constraint(
      { kind: 'regex', pattern: '[A-Z]{3}-\\d+', partialMatch: false },
      'A SKU is 3 capitals, a dash, and digits.',
    );

    const type = valueType({ kind: 'string' }, length, regex);
    const check = valueTypeCheck(type);

    expect(check('ABC-1234')).toBeUndefined();
    expect(check('abc')).toBe(length);
    expect(check('abc-1234')).toBe(regex);
    expect(check('ab')).toBe(length);
  });

  it(`${constraints}: a value type with no constraint accepts each value`, () => {
    const check = valueTypeCheck(valueType({ kind: 'string' }));

    expect([check(''), check('x')]).toEqual([undefined, undefined]);
  });

  it(`${constraints}: a Decimal enum and range compare by exact value, past 2^53`, () => {
    const enumType = valueType({ kind: 'decimal' }, constraint({ kind: 'enum', options: ['1.5'] }));

    expect(failedRule(enumType, '1.50')).toBeUndefined();
    expect(failedRule(enumType, '1.500000000000000000001')).toBeDefined();

    const range = valueType({ kind: 'decimal' }, constraint({ kind: 'range', maximum: '9007199254740992' }));

    expect(failedRule(range, '9007199254740992')).toBeUndefined();
    expect(failedRule(range, '9007199254740992.0')).toBeUndefined();
    expect(failedRule(range, '9007199254740993')).toBeDefined();
  });
});

describe('compareScalar', () => {
  it(`${constraints}: a Decimal compares by its exact value`, () => {
    expect(compareScalar('decimal', '1.5', '1.50')).toBe(0);
    expect(compareScalar('decimal', '9007199254740993', '9007199254740992')).toBe(1);
    expect(compareScalar('decimal', '-0.1', '0')).toBe(-1);
    expect(compareScalar('decimal', 'x', '1')).toBeUndefined();
  });

  it(`${constraints}: the other base types compare as number, point in time, or text`, () => {
    expect(compareScalar('integer', 2, 10)).toBe(-1);
    expect(compareScalar('double', 1.5, 1.5)).toBe(0);
    expect(compareScalar('double', Number.NaN, 1)).toBeUndefined();
    expect(compareScalar('timestamp', '2026-01-01T01:00:00+01:00', '2026-01-01T00:00:00Z')).toBe(0);
    expect(compareScalar('date', '2026-02-01', '2026-01-31')).toBe(1);
    expect(compareScalar('string', 'a', 'b')).toBe(-1);
  });
});

describe('regexOf', () => {
  it(`${constraints}: 1 engine and 1 anchor rule: a full match wraps the pattern, and a pattern with a bar stays whole`, () => {
    const full = regexOf('a|b', false);

    expect(full?.('a')).toBe(true);
    expect(full?.('b')).toBe(true);
    expect(full?.('ab')).toBe(false);
    expect(full?.('xa')).toBe(false);
    expect(regexOf('a|b', true)?.('xa')).toBe(true);
  });

  it(`${constraints}: a pattern that does not compile gives undefined`, () => {
    expect(regexOf('(?i)abc', false)).toBeUndefined();
    expect(regexOf('(', true)).toBeUndefined();
  });

  it(`${constraints}: a pattern that does not compile alone matches no value, even when the anchors would close it`, () => {
    for (const partialMatch of [false, true]) {
      expect(regexOf('a)|(?:b', partialMatch)).toBeUndefined();
    }
  });
});

describe('constraintText', () => {
  it(`${constraints}: gives the plain words of each kind`, () => {
    const words: [ValueTypeRule, string][] = [
      [{ kind: 'enum', options: ['open', 'done'] }, 'is one of "open", "done"'],
      [{ kind: 'enum', options: [1, 2] }, 'is one of 1, 2'],
      [{ kind: 'enum', options: [true] }, 'is one of true'],
      [{ kind: 'range', minimum: 0, maximum: 100 }, 'is at least 0 and at most 100'],
      [{ kind: 'range', minimum: 0 }, 'is at least 0'],
      [{ kind: 'range', maximum: 100 }, 'is at most 100'],
      [{ kind: 'range', minimum: '2026-01-01' }, 'is at least "2026-01-01"'],
      [{ kind: 'length', minimum: 6, maximum: 12 }, 'has 6 to 12 characters'],
      [{ kind: 'length', minimum: 6 }, 'has at least 6 characters'],
      [{ kind: 'length', maximum: 12 }, 'has at most 12 characters'],
      [{ kind: 'regex', pattern: '[A-Z]{3}-\\d+', partialMatch: false }, 'matches the regex [A-Z]{3}-\\d+ in full'],
      [{ kind: 'regex', pattern: '[A-Z]{3}', partialMatch: true }, 'contains a match of the regex [A-Z]{3}'],
      [{ kind: 'uuid' }, 'is a UUID'],
      [
        {
          kind: 'array',
          minimumSize: 1,
          maximumSize: 5,
          uniqueValues: true,
          element: { kind: 'enum', options: ['a', 'b'] },
        },
        'is a list of 1 to 5 elements, with no element 2 times, and each element is one of "a", "b"',
      ],
      [{ kind: 'array', minimumSize: 1, uniqueValues: false }, 'is a list of at least 1 elements'],
      [{ kind: 'array', maximumSize: 5, uniqueValues: false }, 'is a list of at most 5 elements'],
      [{ kind: 'array', uniqueValues: false }, 'is a list'],
    ];

    for (const [rule, text] of words) expect(constraintText(rule)).toBe(text);
  });
});
