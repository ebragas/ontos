import { readFileSync } from 'node:fs';
import type { PublishedFunctions } from '../../src/publish/index.ts';

export function committedFunctions(version: '0.4.0' | '0.6.3' | '0.7.0'): PublishedFunctions {
  const stem = version === '0.7.0' ? '0.6.3' : version;
  const read = (file: string) => readFileSync(new URL(`./${stem}.${file}`, import.meta.url), 'utf8');
  const { discovered } = JSON.parse(read('json')) as Pick<PublishedFunctions, 'discovered'>;

  return { discovered, bundle: read('bundle.js') };
}
