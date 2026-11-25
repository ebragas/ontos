import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKER = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8');

const specifiers = (source: string): string[] =>
  [...source.matchAll(/^\s*(?:import|export)\b[^'"`;=(]*?(?:\bfrom\s*)?['"]([^'"]+)['"]/gm)].map(
    (match) => match[1] ?? '',
  );

describe('the imports of the worker script', () => {
  it('service/observability#traces: each import of worker.ts starts with node:', () => {
    const found = specifiers(WORKER);

    expect(found).not.toEqual([]);
    expect(found.filter((specifier) => !specifier.startsWith('node:'))).toEqual([]);
  });

  it('finds a package import, a type import, a side-effect import, and a re-export', () => {
    const source =
      "import { a } from '@opentelemetry/api';\nimport type { B } from '../spans/index.ts';\nimport 'x';\nexport { c } from \"y\";\n";

    expect(specifiers(source)).toEqual(['@opentelemetry/api', '../spans/index.ts', 'x', 'y']);
  });
});
