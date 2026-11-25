import { describe, expect, it } from 'vitest';
import { newVersion } from './service.test-utils.ts';

describe('newVersion', () => {
  it('accepts a version that is not in before', () => {
    expect('742').toEqual(newVersion());
    expect('742').toEqual(newVersion('741'));
  });

  it('refuses 1, the column default, with and without before', () => {
    expect('1').not.toEqual(newVersion());
    expect('1').not.toEqual(newVersion('2'));
  });

  it('refuses a version in before', () => {
    expect('742').not.toEqual(newVersion('742'));
    expect('742').not.toEqual(newVersion('5', '742'));
  });

  it.each([['0'], [''], ['01'], ['07'], ['7a'], ['-7'], [' 742']])('refuses the text %j', (actual) => {
    expect(actual).not.toEqual(newVersion());
  });

  it('refuses a value that is not a string', () => {
    expect(742).not.toEqual(newVersion());
    expect(742n).not.toEqual(newVersion());
    expect(null).not.toEqual(newVersion());
  });
});
