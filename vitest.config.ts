import { defineConfig } from 'vitest/config';

const POSTGRES = 'packages/service/src/db/postgresContainer.test-utils.ts';
const MCP_TESTS = 'packages/*/src/**/*.mcp.test.ts';

const unit = {
  name: 'unit',
  include: ['packages/*/src/**/*.test.ts', 'packages/service/twin/**/*.test.ts', 'tools/**/*.test.ts'],
  exclude: ['**/*.sql.test.ts', MCP_TESTS, '**/node_modules/**'],
};

export default defineConfig({
  test: {
    onConsoleLog: (log: string) => !log.startsWith('{"'),
    globalSetup: ['test/tempFolder.ts', 'test/sharedBuild.ts'],
    projects: [
      { test: unit },
      {
        test: {
          name: 'mcp',
          include: [MCP_TESTS],
          globalSetup: [POSTGRES],
        },
      },
      {
        test: {
          name: 'sql',
          include: [
            'packages/*/src/**/*.sql.test.ts',
            'packages/service/twin/**/*.sql.test.ts',
            'tools/**/*.sql.test.ts',
          ],
          globalSetup: [POSTGRES],
          setupFiles: ['packages/service/src/spans/traceRoutes.test-utils.ts'],
        },
      },
    ],
  },
});
