import { describe, expect, it } from 'vitest';
import { notesApp } from './apps.test-utils.ts';
import { cli, stubFetch } from './cli.test-utils.ts';
import { localGate, toLocal } from './sql.test-utils.ts';

const local = localGate();

describe('the CLI against the service from node.ts', () => {
  it('service/testing#test-kinds: a CLI test runs a command against the service from node.ts, with a GitHub OIDC token for the base URL', async () => {
    const run = await cli(['validate', ...local.flags()], {
      cwd: notesApp(),
      fetch: stubFetch(toLocal),
      env: local.service.oidcEnv,
    });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(local.service.audiences.at(-1)).toBe('https://app.ontos.example');
  });
});
