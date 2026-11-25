import { describe, expect, it } from 'vitest';
import { compareDecimal, parseDecimal } from './index.ts';

const BASE_TYPES = 'ontology/object-link-types/properties#base-types';
const VALUE_RULES = 'ontology/object-link-types/properties#value-rules-on-write';

const text = (value: string) => ({ ok: true, text: value });
const notDecimal = { ok: false, refusal: 'notDecimal' };
const doesNotFit = { ok: false, refusal: 'doesNotFit' };

describe('parseDecimal', () => {
  it.each([
    ['+1.50', '1.5'],
    ['1.5e3', '1500'],
    ['-0.0', '0'],
    [0.1 + 0.2, '0.30000000000000004'],
    ['.5', '0.5'],
    ['5.', '5'],
    ['+.5e1', '5'],
    ['1.5E-2', '0.015'],
    ['-0', '0'],
    ['-0e5', '0'],
    [-0, '0'],
    [1e21, '1000000000000000000000'],
    ['9007199254740993', '9007199254740993'],
    ['-00012.3400', '-12.34'],
  ])(`${BASE_TYPES}: %j gives the plain text %j`, (value, plain) => {
    expect(parseDecimal(value)).toEqual(text(plain));
  });

  it.each([
    ['a boolean', true],
    ['null', null],
    ['a bigint', 1n],
    ['an object', { value: '1' }],
    ['NaN', Number.NaN],
    ['an infinity', Number.POSITIVE_INFINITY],
    ['a negative infinity', Number.NEGATIVE_INFINITY],
    ['an empty string', ''],
    ['a lone point', '.'],
    ['a lone sign', '-'],
    ['2 signs', '+-1'],
    ['a space', ' 1'],
    ['a comma', '1,5'],
    ['an exponent with no digits', '1e'],
    ['the word Infinity', 'Infinity'],
    ['a hex number', '0x10'],
    ['text over 1,000 characters', '1'.repeat(1_001)],
    ['an exponent over 1,000', '1e1001'],
    ['an exponent under -1,000', '1e-1001'],
    ['a huge exponent', '1e999999'],
  ])(`${BASE_TYPES}: refuses %s as not a Decimal`, (_name, value) => {
    expect(parseDecimal(value)).toEqual(notDecimal);
  });

  it(`${BASE_TYPES}: accepts 1,000 characters and an exponent of 1,000 in size`, () => {
    expect(parseDecimal('1'.repeat(1_000))).toEqual(text('1'.repeat(1_000)));
    expect(parseDecimal('1e1000')).toEqual(text(`1${'0'.repeat(1_000)}`));
    expect(parseDecimal('1e-1000')).toEqual(text(`0.${'0'.repeat(999)}1`));
  });

  it.each([
    ['1299.9', 6, 2, '1299.90'],
    [1299.9, 6, 2, '1299.90'],
    ['1.500', 3, 2, '1.50'],
    ['+1.5e1', 4, 2, '15.00'],
    ['-12', 2, 0, '-12'],
    ['0', 2, 2, '0.00'],
    ['-0.000', 1, 1, '0.0'],
    ['0e999', 1, 0, '0'],
    ['.99', 2, 2, '0.99'],
    ['9999.99', 6, 2, '9999.99'],
    ['0.0012', 2, 4, '0.0012'],
  ])(`${VALUE_RULES}: %j fits numeric(%i, %i) as %j`, (value, precision, scale, padded) => {
    expect(parseDecimal(value, { precision, scale })).toEqual(text(padded));
  });

  it.each([
    ['1299.955', 6, 2],
    ['1299.999', 6, 2],
    ['99999.99', 6, 2],
    [0.1 + 0.2, 38, 16],
    ['1', 2, 2],
    ['1e2', 2, 0],
    ['1.5e-3', 4, 2],
    ['0.012', 2, 4],
  ])(`${VALUE_RULES}: %j does not fit numeric(%i, %i), and is never rounded`, (value, precision, scale) => {
    expect(parseDecimal(value, { precision, scale })).toEqual(doesNotFit);
  });

  it(`${VALUE_RULES}: a value that is not a Decimal is not a Decimal also with a fit`, () => {
    expect(parseDecimal('1e1001', { precision: 38, scale: 2 })).toEqual(notDecimal);
    expect(parseDecimal('abc', { precision: 38, scale: 2 })).toEqual(notDecimal);
  });
});

describe('compareDecimal', () => {
  it.each([
    ['9007199254740993', '9007199254740992', 1],
    ['9007199254740992', '9007199254740993', -1],
    ['1.5', '1.50', 0],
    ['-1', '1', -1],
    ['0', '0.00', 0],
    ['-0.01', '0', -1],
    ['1299.90', '1299.9', 0],
    ['+1.5e3', '1500', 0],
    ['.5', '-5.', 1],
  ])(`${BASE_TYPES}: %j against %j gives %i`, (left, right, order) => {
    expect(compareDecimal(left, right)).toBe(order);
  });
});
