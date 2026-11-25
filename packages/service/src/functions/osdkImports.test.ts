import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const service = fileURLToPath(new URL('../../', import.meta.url));

function osdkImports(): string[] {
  const files = readdirSync(`${service}src`, { recursive: true, encoding: 'utf8' }).filter(
    (file) => file.endsWith('.ts') && !/\.(test|test-utils|fixture)\.ts$/.test(file),
  );

  return files.flatMap((file) => {
    const text = readFileSync(`${service}src/${file}`, 'utf8');

    const statements = [...text.matchAll(/^(?:import|export)\s+(type\s)?[^;]*?from\s+['"](@osdk\/[^'"]+)['"]/gm)].map(
      ([, type, name]) => `${type ? 'type' : 'value'} ${name}`,
    );

    const dynamic = [...text.matchAll(/import\(\s*['"](@osdk\/[^'"]+)['"]/g)].map(([, name]) => `value ${name}`);

    return [...statements, ...dynamic];
  });
}

describe('OSDK code', () => {
  it('service/code-layout#osdk-code: the service imports only the types of @osdk/foundry.ontologies, @osdk/foundry.admin, @osdk/client.unstable, and @osdk/functions', () => {
    expect([...new Set(osdkImports())].sort()).toEqual([
      'type @osdk/client.unstable',
      'type @osdk/foundry.admin',
      'type @osdk/foundry.ontologies',
      'type @osdk/functions',
    ]);

    const json = JSON.parse(readFileSync(`${service}package.json`, 'utf8')) as {
      devDependencies: Record<string, string>;
    };

    expect(Object.keys(json.devDependencies)).toContain('@osdk/functions');
  });
});
