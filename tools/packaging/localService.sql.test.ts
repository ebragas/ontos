import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { requestSharedBuild } from '../../test/sharedBuildClient.ts';
import { packCli, run } from '../../packages/cli/src/pack.test-utils.ts';
import { LOCAL_APP, localTwin } from '../../packages/service/src/localTwin.test-utils.ts';
import { orThrow } from '../../packages/service/src/errors/fallible.ts';
import { makeServicePackage } from './service-package.ts';

const root = new URL('../../', import.meta.url).pathname;
const exec = promisify(execFile);

const localContainers = (): string[] =>
  execFileSync('docker', ['ps', '-a', '--filter', 'name=ontology-local-', '--format', '{{.Names}}'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

const SCRIPT = `
import { run } from '@ericbragas/ontos-cli';
import { startLocalService } from '@ericbragas/ontos-service/testing';
const local = await startLocalService({ app: process.argv[2], folder: process.argv[3], cli: run });
const call = (path, body) => fetch(local.url + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + local.token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
const { data: [{ rid }] } = await call('/api/v2/ontologies');
const options = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };
await call('/api/v2/ontologies/' + rid + '/actions/com.example.twin.create-account/apply', { parameters: { accountId: 'packed-1', name: 'Packed', phase: 'customer' }, options });
const closed = await call('/api/v2/ontologies/' + rid + '/actions/com.example.twin.close-account-action/apply', { parameters: { account: 'packed-1' }, options });
const containers = (await import('node:child_process')).execFileSync('docker', ['ps', '--filter', 'name=ontology-local-', '--format', '{{.Names}}'], { encoding: 'utf8' }).split('\\n').filter(Boolean);
await local.stop();
console.log(JSON.stringify({ url: local.url, edits: closed.edits, containers }));
`;

describe('the packed service file', () => {
  let app: string;
  let before: string[];
  let after: string[];

  let answer: {
    url: string;
    edits: { edits: unknown[] };
    containers: string[];
  };

  beforeAll(async () => {
    const sharedService = await requestSharedBuild('servicePackage');

    const [serviceFile, cli] = await Promise.all([
      sharedService
        ? Promise.resolve(sharedService.file)
        : (async () => {
            const service = join(mkdtempSync(join(tmpdir(), 'service-package-')), 'service');

            await orThrow(makeServicePackage(service));

            const [packed] = JSON.parse(
              await run(
                'npm',
                ['pack', service, '--ignore-scripts', '--json', '--pack-destination', join(service, '..')],
                root,
              ),
            ) as [{ filename: string }];

            return join(service, '..', packed.filename);
          })(),
      packCli(),
    ]);

    app = mkdtempSync(join(tmpdir(), 'local-service-app-'));

    writeFileSync(join(app, 'package.json'), '{"name":"app","private":true}\n');

    await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', serviceFile, cli.file], app);

    writeFileSync(join(app, 'local.mjs'), SCRIPT);

    before = localContainers();

    const { stdout } = await exec(process.execPath, ['local.mjs', LOCAL_APP, localTwin()], {
      cwd: app,
      timeout: 180_000,
    });

    after = localContainers();

    answer = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as {
      url: string;
      edits: { edits: unknown[] };
      containers: string[];
    };
  }, 600_000);

  it('service/testing#local-service: node runs the test entry from node_modules, on its own Postgres container, and stop leaves no container and no open handle', () => {
    expect(answer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    expect(answer.edits.edits).toEqual([
      { type: 'modifyObject', primaryKey: 'packed-1', objectType: 'com.example.twin.Account' },
    ]);

    expect(answer.containers.filter((name) => !before.includes(name))).toHaveLength(1);
    expect(after).toEqual(before);
  });
});
