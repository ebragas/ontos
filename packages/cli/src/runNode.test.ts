import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runNode } from './appRunner.ts';
import { orThrow } from './fallible.ts';
import { tempFolder } from './cli.test-utils.ts';

describe('runNode', () => {
  it('a package script gets no token variable, and it still gets the other variables', async () => {
    const before = {
      ONTOLOGY_TOKEN: process.env['ONTOLOGY_TOKEN'],
      ACTIONS_ID_TOKEN_REQUEST_URL: process.env['ACTIONS_ID_TOKEN_REQUEST_URL'],
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'],
      ONTOLOGY_APP: process.env['ONTOLOGY_APP'],
    };

    process.env['ONTOLOGY_TOKEN'] = 'secret-token';
    process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = 'https://oidc.example/token';
    process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'request-token';
    process.env['ONTOLOGY_APP'] = 'acme';

    try {
      const cwd = tempFolder();

      writeFileSync(
        join(cwd, 'print-env.js'),
        'process.stdout.write(JSON.stringify({ ONTOLOGY_TOKEN: process.env.ONTOLOGY_TOKEN, ACTIONS_ID_TOKEN_REQUEST_URL: process.env.ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, ONTOLOGY_APP: process.env.ONTOLOGY_APP }));\n',
      );

      const output = JSON.parse(await orThrow(runNode(join(cwd, 'print-env.js'), [], cwd))) as Record<string, unknown>;

      expect(output).toEqual({
        ONTOLOGY_TOKEN: undefined,
        ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
        ONTOLOGY_APP: 'acme',
      });
    } finally {
      if (before.ONTOLOGY_TOKEN === undefined) delete process.env['ONTOLOGY_TOKEN'];
      else process.env['ONTOLOGY_TOKEN'] = before.ONTOLOGY_TOKEN;

      if (before.ACTIONS_ID_TOKEN_REQUEST_URL === undefined) delete process.env['ACTIONS_ID_TOKEN_REQUEST_URL'];
      else process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = before.ACTIONS_ID_TOKEN_REQUEST_URL;

      if (before.ACTIONS_ID_TOKEN_REQUEST_TOKEN === undefined) delete process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
      else process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = before.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

      if (before.ONTOLOGY_APP === undefined) delete process.env['ONTOLOGY_APP'];
      else process.env['ONTOLOGY_APP'] = before.ONTOLOGY_APP;
    }
  });
});
