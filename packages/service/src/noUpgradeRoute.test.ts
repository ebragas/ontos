import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeServer } from './node.ts';
import { closeServer, listenLocal } from './localServer.test-utils.ts';
import { emptyDb, testInput, testSettings } from './service.test-utils.ts';
import { createTestIssuer, type TestIssuer } from './tokens.test-utils.ts';
import { fallibleOf } from './db/promise.test-utils.ts';

let server: Server;
let base: string;
let issuer: TestIssuer;

beforeAll(async () => {
  issuer = await createTestIssuer(testSettings.auth);

  server = createNodeServer({
    ...testInput,
    db: fallibleOf(emptyDb),
    directDb: fallibleOf(emptyDb),
    keys: issuer.keys,
  });

  base = await listenLocal(server);
});

afterAll(() => closeServer(server));

describe('the upgrade path', () => {
  it('service/publish#upgrade: POST /api/ontology-service/v1/upgrade from the publish caller gets 404, as each unknown path does', async () => {
    const send = async (path: string) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await issuer.github()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ product: 'twin', after: 0 }),
      });

      return { status: response.status, body: await response.text() };
    };

    expect(await send('/api/ontology-service/v1/upgrade')).toEqual({ status: 404, body: '' });

    expect(await send('/api/ontology-service/v1/no-such-route')).toEqual({ status: 404, body: '' });
  });
});

const repo = fileURLToPath(new URL('../../../', import.meta.url));

const REMOVED_NAMES = [
  'v1/upgrade',
  'installationbehind',
  'upgraderequest',
  'upgraderesponse',
  'upgradefailure',
  'upgradeproduct',
  'upgradepass',
  'behindrow',
];

function removedNames(text: string): string[] {
  const plain = text.toLowerCase().replace(/['"`]\s*\+\s*['"`]/g, '');

  return REMOVED_NAMES.filter((name) => plain.includes(name));
}

describe('the names of the upgrade route and the behind state', () => {
  let trackedSourceFiles: string[] = [];

  beforeAll(() => {
    trackedSourceFiles = execFileSync(
      'git',
      ['ls-files', 'packages/service/src', 'packages/service/api', 'packages/cli/src', 'tools'],
      { cwd: repo, encoding: 'utf8' },
    )
      .split('\n')
      .filter(
        (file) =>
          file.endsWith('.ts') && !/\.(test|test-utils|fixture)\.ts$/.test(file) && existsSync(`${repo}${file}`),
      );
  });

  it('a probe text names each one in any case and in any quoting', () => {
    expect(
      removedNames(
        '\'OntologyService:InstallationBehind\' `/API/ontology-service/V1/UPGRADE` "Upgrade" + "Response" upgrade_pass',
      ),
    ).toEqual(['v1/upgrade', 'installationbehind', 'upgraderesponse']);
  });

  it('no source file of the service, the CLI, or the tools names one', () => {
    expect(trackedSourceFiles.length).toBeGreaterThan(100);

    expect(
      trackedSourceFiles.flatMap((file) =>
        removedNames(readFileSync(`${repo}${file}`, 'utf8')).map((name) => `${file}: ${name}`),
      ),
    ).toEqual([]);
  });
});
