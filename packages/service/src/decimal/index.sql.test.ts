import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { compareDecimal, parseDecimal } from './index.ts';

const BASE_TYPES = 'ontology/object-link-types/properties#base-types';
const VALUE_RULES = 'ontology/object-link-types/properties#value-rules-on-write';

const RUNS = { seed: 20261119, numRuns: 25 };
const BATCH = { minLength: 1, maxLength: 80 };

const digits = (max: number) => fc.string({ unit: fc.constantFrom(...Array.from('0123456789')), maxLength: max });

const decimalText = fc
  .record({
    sign: fc.constantFrom('', '+', '-'),
    whole: digits(40),
    point: fc.boolean(),
    fraction: digits(40),
    trailing: fc.constantFrom('', '0', '00'),
    exponent: fc.option(
      fc.record({
        e: fc.constantFrom('e', 'E'),
        sign: fc.constantFrom('', '+', '-'),
        size: fc.oneof(
          { weight: 4, arbitrary: fc.integer({ min: 0, max: 45 }) },
          { weight: 1, arbitrary: fc.integer({ min: 0, max: 1_000 }) },
        ),
      }),
    ),
  })
  .filter(
    ({ whole, point, fraction, trailing }) => whole.length > 0 || (point && fraction.length + trailing.length > 0),
  )
  .map(({ sign, whole, point, fraction, trailing, exponent }) => {
    const exp = exponent === null ? '' : `${exponent.e}${exponent.sign}${exponent.size}`;

    return `${sign}${whole}${point ? `.${fraction}${trailing}` : ''}${exp}`;
  });

const fit = fc.record({ precision: fc.integer({ min: 1, max: 38 }), scale: fc.integer({ min: 0, max: 38 }) });

let postgres: TestPostgres;
let client: pg.Client;

beforeAll(async () => {
  postgres = await startPostgres();

  client = new pg.Client({ connectionString: postgres.url });

  await client.connect();

  await client.query(`
    CREATE FUNCTION pg_temp.fitted(v text, p int, s int) RETURNS text LANGUAGE plpgsql AS $$
    DECLARE fitted numeric; text_form text;
    BEGIN
      EXECUTE format('SELECT $1::numeric(%s, %s), $1::numeric(%s, %s)::text', p, s, p, s) INTO fitted, text_form USING v;
      RETURN CASE WHEN fitted = v::numeric THEN text_form END;
    EXCEPTION WHEN numeric_value_out_of_range THEN RETURN NULL;
    END $$`);
});

afterAll(async () => {
  await client?.end();

  await postgres?.stop();
});

const column = async <T>(sql: string, params: unknown[]): Promise<T[]> =>
  (await client.query<{ result: T }>(sql, params)).rows.map((row) => row.result);

describe('the Postgres facts that the decimal module relies on', () => {
  it('Postgres 17 reads a leading +, .5, 5., and an exponent, has trim_scale, and refuses 1e999999', async () => {
    expect(await column<string>('SELECT current_setting($1) AS result', ['server_version'])).toEqual([
      expect.stringMatching(/^17\./),
    ]);

    const inputs = ['+1.50', '.5', '5.', '1.5e3', '1.5E-2', '-0.0', '+.5e1'];

    const { rows } = await client.query<{ cast: string; trimmed: string }>(
      'SELECT v::numeric::text AS cast, trim_scale(v::numeric)::text AS trimmed FROM unnest($1::text[]) WITH ORDINALITY AS t(v, i) ORDER BY i',
      [inputs],
    );

    expect(rows).toEqual([
      { cast: '1.50', trimmed: '1.5' },
      { cast: '0.5', trimmed: '0.5' },
      { cast: '5', trimmed: '5' },
      { cast: '1500', trimmed: '1500' },
      { cast: '0.015', trimmed: '0.015' },
      { cast: '0.0', trimmed: '0' },
      { cast: '5', trimmed: '5' },
    ]);

    expect(inputs.map((value) => parseDecimal(value))).toEqual(
      rows.map(({ trimmed }) => ({ ok: true, text: trimmed })),
    );

    await expect(client.query("SELECT '1e999999'::numeric")).rejects.toThrow('value overflows numeric format');
  });

  it(`${VALUE_RULES}: parseDecimal refuses each value that a cast to numeric(p, s) rounds or refuses`, async () => {
    expect(
      await column<string | null>(
        'SELECT pg_temp.fitted(v, 6, 2) AS result FROM unnest($1::text[]) WITH ORDINALITY AS t(v, i) ORDER BY i',
        [['1299.9', '1299.999', '99999.99']],
      ),
    ).toEqual(['1299.90', null, null]);

    expect(await column<string>("SELECT '1299.999'::numeric(6, 2)::text AS result", [])).toEqual(['1300.00']);

    await expect(client.query("SELECT '99999.99'::numeric(6, 2)")).rejects.toThrow('numeric field overflow');

    expect(['1299.9', '1299.999', '99999.99'].map((value) => parseDecimal(value, { precision: 6, scale: 2 }))).toEqual([
      { ok: true, text: '1299.90' },
      { ok: false, refusal: 'doesNotFit' },
      { ok: false, refusal: 'doesNotFit' },
    ]);
  });
});

describe('parseDecimal and compareDecimal against Postgres numeric', () => {
  it(`${VALUE_RULES}: with a fit, parseDecimal refuses exactly the values that numeric(p, s) changes or refuses, and else gives its text`, async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(decimalText, fit), BATCH), async (batch) => {
        const expected = await column<string | null>(
          'SELECT pg_temp.fitted(v, p, s) AS result FROM unnest($1::text[], $2::int[], $3::int[]) WITH ORDINALITY AS t(v, p, s, i) ORDER BY i',
          [batch.map(([value]) => value), batch.map(([, f]) => f.precision), batch.map(([, f]) => f.scale)],
        );

        const actual = batch.map(([value, f]) => parseDecimal(value, f));

        expect(actual).toEqual(
          expected.map((text) => (text === null ? { ok: false, refusal: 'doesNotFit' } : { ok: true, text })),
        );
      }),
      RUNS,
    );
  });

  it(`${BASE_TYPES}: the plain text of parseDecimal is trim_scale($1::numeric)::text`, async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(decimalText, BATCH), async (batch) => {
        const expected = await column<string>(
          'SELECT trim_scale(v::numeric)::text AS result FROM unnest($1::text[]) WITH ORDINALITY AS t(v, i) ORDER BY i',
          [batch],
        );

        expect(batch.map((value) => parseDecimal(value))).toEqual(expected.map((text) => ({ ok: true, text })));
      }),
      RUNS,
    );
  });

  it(`${BASE_TYPES}: compareDecimal gives the sign of $1::numeric - $2::numeric`, async () => {
    const leadingZeros = (value: string) => value.replace(/^[+-]?/, '$&00');

    const near = decimalText.chain((value) =>
      fc.tuple(fc.constant(value), fc.oneof(decimalText, fc.constant(value), fc.constant(leadingZeros(value)))),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(near, BATCH), async (batch) => {
        const expected = await column<number>(
          'SELECT sign(a::numeric - b::numeric)::int AS result FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(a, b, i) ORDER BY i',
          [batch.map(([left]) => left), batch.map(([, right]) => right)],
        );

        expect(batch.map(([left, right]) => compareDecimal(left, right))).toEqual(expected);
      }),
      RUNS,
    );
  });
});
