import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../../../../vitest.config.ts';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path: string) => readFileSync(`${repo}${path}`, 'utf8');

interface Project {
  readonly test?: {
    readonly name?: string;
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
    readonly globalSetup?: readonly string[];
  };
}

const projects = ((config as { test?: { projects?: readonly Project[] } }).test?.projects ?? []).map(
  (project) => project.test ?? {},
);

const project = (name: string) => projects.find((candidate) => candidate.name === name);

describe('the MCP tests', () => {
  it('service/testing#test-kinds: test runs the unit project and the mcp project', () => {
    const { scripts } = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

    expect(scripts.test).toBe('bun run test:unit && bun run test:mcp');
  });

  it('service/testing#test-kinds service/testing#mcp-tests: the mcp project holds packages/*/src/**/*.mcp.test.ts, on the test Postgres container, and the unit project leaves it out', () => {
    expect(project('mcp')).toEqual({
      name: 'mcp',
      include: ['packages/*/src/**/*.mcp.test.ts'],
      globalSetup: ['packages/service/src/db/postgresContainer.test-utils.ts'],
    });

    expect(project('unit')?.exclude).toContain('packages/*/src/**/*.mcp.test.ts');
  });

  it('service/testing#ci service/testing#mcp-tests: the mcp job of ci.yml runs the mcp project once, and checks runs only the unit project', () => {
    const ci = read('.github/workflows/ci.yml');

    const jobSection = (id: string) => {
      const start = ci.indexOf(`\n  ${id}:`);

      expect(start, id).toBeGreaterThanOrEqual(0);

      const rest = ci.slice(start + 1);
      const next = rest.slice(1).search(/\n {2}[\w-]+:\s*(?:\n|$)/);

      return next < 0 ? rest : rest.slice(0, next + 1);
    };

    const checks = jobSection('checks');

    expect(checks).toContain('bun x vitest run --project unit --maxWorkers=2');
    expect(checks).not.toContain('--project mcp');

    const mcp = jobSection('mcp');

    expect(mcp.match(/--project mcp/g)).toEqual(['--project mcp']);
    expect(mcp).toContain('run: bun x vitest run --project mcp');
  });

  it('service/testing#mcp-tests: each MCP test file goes through a stock MCP client, and none imports the mcp module', () => {
    const src = `${repo}packages/service/src/`;

    const tests = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((name) =>
      name.endsWith('.mcp.test.ts'),
    );

    expect(tests.length).toBeGreaterThan(0);

    for (const name of [...tests, 'mcp/mcp.test-utils.ts']) {
      const source = readFileSync(`${src}${name}`, 'utf8');

      const mcpModule = [...source.matchAll(/from '(\.[^']*)'/g)]
        .map((match) => join(dirname(name), match[1] ?? ''))
        .filter((path) => path.startsWith('mcp/') && !/\.(test|test-utils)\.ts$/.test(path));

      expect(mcpModule, name).toEqual([]);
    }

    const harness = readFileSync(`${src}mcp/mcp.test-utils.ts`, 'utf8');

    expect(harness).toContain("from '@modelcontextprotocol/sdk/client/index.js'");
    expect(harness).toContain("from '@modelcontextprotocol/client'");
  });
});
