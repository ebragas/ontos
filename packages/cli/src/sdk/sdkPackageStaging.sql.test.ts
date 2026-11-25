import { describe, expect, it } from 'vitest';
import { changedPaths, committedApp } from '../apps.test-utils.ts';
import {
  hashOf,
  MANIFEST_FIELDS,
  MANIFEST_FIELDS_WITH_DOMAIN,
  NAME,
  stagingApp,
  withStaging,
} from './sdkPackage.test-utils.ts';
import { localGate, toLocal } from '../sql.test-utils.ts';
import { cli, stubFetch, stubRegistry } from '../cli.test-utils.ts';
import type { AsyncFallible } from '../fallible.ts';
import { CliError } from '../cliError.ts';

describe('the Ontology SDK package of a staging publish', () => {
  const local = localGate('staging');

  it('ontology/ontology-sdk/ontology-sdk#contract, ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: a staging publish publishes 1 version 0.0.<run number> of @ontos/<app>-ontology-sdk, with the ontologyHash of the Ontology, the exact @osdk/client peer of the OSDK set, and the dist-tag staging, and moves no other tag, and the package has the ./ontology-service export and its compiled files', async () => {
    const registry = stubRegistry();
    const root = stagingApp();

    const run = await cli(['publish', ...local.flags()], {
      cwd: root,
      fetch: stubFetch(toLocal),
      env: { ...local.service.oidcEnv, GITHUB_RUN_NUMBER: '7' },
      registry,
    });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);

    const answer = run.output as { version: number; metadata: unknown; ontologySdk: unknown };

    expect(answer.version).toBe(1);

    const hash = hashOf(answer.metadata);

    expect(answer.ontologySdk).toEqual({ name: NAME, version: '0.0.7', ontologyHash: hash, action: 'published' });
    expect(registry.published).toHaveLength(1);

    const [published] = registry.published;

    expect(published?.cwd).toBe(root);
    expect(published?.manifest).toEqual({ name: NAME, version: '0.0.7', ...MANIFEST_FIELDS, ontologyHash: hash });
    expect(registry.tags).toEqual([]);

    expect(published?.files).toEqual(
      expect.arrayContaining([
        'index.ts',
        'dist/index.js',
        'dist/index.d.ts',
        'ontology/objects/Note.ts',
        'ontology-service.ts',
        'dist/ontology-service.js',
        'dist/ontology-service.d.ts',
      ]),
    );
  });

  it('a staging publish runs the generator in a temporary folder outside the app, so it changes no file of the app', async () => {
    const registry = stubRegistry();
    const root = committedApp(stagingApp());

    const run = await cli(['publish', ...local.flags()], {
      cwd: root,
      fetch: stubFetch(toLocal),
      env: { ...local.service.oidcEnv, GITHUB_RUN_NUMBER: '13' },
      registry,
    });

    expect(run.stderr).toBe('');
    expect(registry.published).toHaveLength(1);
    expect(changedPaths(root)).toEqual([]);
  });

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: a staging publish publishes no version and moves no tag when a version has the ontologyHash, so a run again after a lost response adds none', async () => {
    const registry = stubRegistry();
    const options = { cwd: stagingApp(), fetch: stubFetch(toLocal), registry };

    const first = await cli(['publish', ...local.flags()], {
      ...options,
      env: { ...local.service.oidcEnv, GITHUB_RUN_NUMBER: '8' },
    });

    const again = await cli(['publish', ...local.flags()], {
      ...options,
      env: { ...local.service.oidcEnv, GITHUB_RUN_NUMBER: '9' },
    });

    expect(again.stderr).toBe('');

    const { ontologySdk } = first.output as { ontologySdk: { ontologyHash: string } };

    expect((again.output as { ontologySdk: unknown }).ontologySdk).toEqual({
      name: NAME,
      version: '0.0.8',
      ontologyHash: ontologySdk.ontologyHash,
      action: 'unchanged',
    });

    expect(registry.published.map(({ manifest }) => manifest['version'])).toEqual(['0.0.8']);
    expect(registry.tags).toEqual([]);
  });

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: a staging publish after a change of 1 WorkOS client ID publishes a new version with a new hash, and the next run with no change gives unchanged', async () => {
    const registry = stubRegistry();

    const publish = (stagingClientId: string, run: string) =>
      cli(['publish', ...local.flags()], {
        cwd: stagingApp(stagingClientId),
        fetch: stubFetch(toLocal),
        env: { ...local.service.oidcEnv, GITHUB_RUN_NUMBER: run },
        registry,
      });

    const first = await publish('client_staging', '14');

    const changed = await publish('client_staging_2', '15');

    const again = await publish('client_staging_2', '16');

    expect(changed.stderr).toBe('');

    const { metadata } = changed.output as { metadata: unknown };

    const [before, after, unchanged] = [first, changed, again].map(
      (run) => (run.output as { ontologySdk: object }).ontologySdk,
    );

    expect(before).toEqual({ name: NAME, version: '0.0.14', ontologyHash: hashOf(metadata), action: 'published' });

    expect(after).toEqual({
      name: NAME,
      version: '0.0.15',
      ontologyHash: hashOf(metadata, withStaging('client_staging_2')),
      action: 'published',
    });

    expect(hashOf(metadata, withStaging('client_staging_2'))).not.toBe(hashOf(metadata));
    expect(unchanged).toEqual({ ...after, action: 'unchanged' });
    expect(registry.published.map(({ manifest }) => manifest['version'])).toEqual(['0.0.14', '0.0.15']);
  });

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: a staging publish whose package publish failed adds the missing version on the next run', async () => {
    const registry = stubRegistry();

    const failing = {
      ...registry,
      async *publish(): AsyncFallible<void, CliError> {
        return yield new CliError('npm publish failed: 503');
      },
    };

    const failed = await cli(['publish', ...local.flags()], {
      cwd: stagingApp(),
      fetch: stubFetch(toLocal),
      env: { ...local.service.oidcEnv, GITHUB_RUN_NUMBER: '10' },
      registry: failing,
    });

    expect(failed.code).toBe(1);
    expect(failed.stderr).toBe(`${JSON.stringify({ message: 'npm publish failed: 503' })}\n`);

    const again = await cli(['publish', ...local.flags()], {
      cwd: stagingApp(),
      fetch: stubFetch(toLocal),
      env: { ...local.service.oidcEnv, GITHUB_RUN_NUMBER: '11' },
      registry,
    });

    expect(again.stderr).toBe('');
    expect(registry.published.map(({ manifest }) => manifest['version'])).toEqual(['0.0.11']);
  });

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: a staging publish that needs a new version stops when GITHUB_RUN_NUMBER is not a run number', async () => {
    for (const [value, shown] of [
      [undefined, 'not set'],
      ['abc', '"abc"'],
    ] as const) {
      const registry = stubRegistry();

      const run = await cli(['publish', ...local.flags()], {
        cwd: stagingApp(),
        fetch: stubFetch(toLocal),
        env: { ...local.service.oidcEnv, GITHUB_RUN_NUMBER: value },
        registry,
      });

      expect(run.code).toBe(1);

      expect(run.stderr).toBe(
        `${JSON.stringify({ message: `The Ontology SDK package needs a new version, 0.0.<GITHUB_RUN_NUMBER>, and GITHUB_RUN_NUMBER is ${shown}. Run ontos publish in the publish workflow.` })}\n`,
      );

      expect(registry.published).toEqual([]);
    }
  });

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: validate publishes no package', async () => {
    const registry = stubRegistry();

    const run = await cli(['validate', ...local.flags()], {
      cwd: stagingApp(),
      fetch: stubFetch(toLocal),
      env: { ...local.service.oidcEnv, GITHUB_RUN_NUMBER: '12' },
      registry,
    });

    expect(run.code).toBe(0);
    expect(registry.published).toEqual([]);
    expect((run.output as Record<string, unknown>)['ontologySdk']).toBeUndefined();
  });

  it('ontology/ontology-sdk/ontology-sdk#contract, ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: a staging publish with domain/ exports ./domain without test files, and an edit to domain/ alone publishes a new SDK version with no IR change', async () => {
    const registry = stubRegistry();
    const domainIndex = "export * from './money.ts';\n";
    const moneyV1 = 'export const ZERO = 0;\n';
    const moneyV2 = 'export const ZERO = 0;\nexport const ONE = 1;\n';
    const testFile = "import { expect, it } from 'vitest';\nit('ok', () => expect(1).toBe(1));\n";

    const publish = (money: string, run: string) =>
      cli(['publish', ...local.flags()], {
        cwd: stagingApp(undefined, {
          'domain/index.ts': domainIndex,
          'domain/money.ts': money,
          'domain/money.test.ts': testFile,
        }),
        fetch: stubFetch(toLocal),
        env: { ...local.service.oidcEnv, GITHUB_RUN_NUMBER: run },
        registry,
      });

    const first = await publish(moneyV1, '40');

    expect([first.code, first.stderr]).toEqual([0, '']);

    const { metadata, version: versionBefore } = first.output as { metadata: unknown; version: number };

    const hash1 = hashOf(metadata, withStaging(), [
      { path: 'index.ts', bytes: Buffer.from(domainIndex) },
      { path: 'money.ts', bytes: Buffer.from(moneyV1) },
    ]);

    expect((first.output as { ontologySdk: unknown }).ontologySdk).toEqual({
      name: NAME,
      version: '0.0.40',
      ontologyHash: hash1,
      action: 'published',
    });

    expect(registry.published[0]?.manifest).toEqual({
      name: NAME,
      version: '0.0.40',
      ...MANIFEST_FIELDS_WITH_DOMAIN,
      ontologyHash: hash1,
    });

    expect(registry.published[0]?.files).toEqual(
      expect.arrayContaining([
        'domain/index.ts',
        'domain/money.ts',
        'dist/domain/index.js',
        'dist/domain/index.d.ts',
        'dist/domain/money.js',
        'dist/domain/money.d.ts',
      ]),
    );

    expect(registry.published[0]?.files).not.toContain('domain/money.test.ts');

    const edited = await publish(moneyV2, '41');

    expect([edited.code, edited.stderr]).toEqual([0, '']);

    const { version: versionAfter, ontologySdk: editedSdk } = edited.output as {
      version: number;
      ontologySdk: unknown;
    };

    expect(versionAfter).toBe(versionBefore);

    const hash2 = hashOf(metadata, withStaging(), [
      { path: 'index.ts', bytes: Buffer.from(domainIndex) },
      { path: 'money.ts', bytes: Buffer.from(moneyV2) },
    ]);

    expect(hash2).not.toBe(hash1);
    expect(editedSdk).toEqual({ name: NAME, version: '0.0.41', ontologyHash: hash2, action: 'published' });

    const unchanged = await publish(moneyV2, '42');

    expect([unchanged.code, unchanged.stderr]).toEqual([0, '']);

    expect((unchanged.output as { ontologySdk: unknown }).ontologySdk).toEqual({
      name: NAME,
      version: '0.0.41',
      ontologyHash: hash2,
      action: 'unchanged',
    });

    expect(registry.published.map(({ manifest }) => manifest['version'])).toEqual(['0.0.40', '0.0.41']);
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: validate stops before calling the service when domain/ has a disallowed import', async () => {
    const fetch = stubFetch(toLocal);

    const run = await cli(['validate', ...local.flags()], {
      cwd: stagingApp(undefined, { 'domain/index.ts': "import { chunk } from 'lodash';\nexport const f = chunk;\n" }),
      fetch,
      env: local.service.oidcEnv,
    });

    expect(run.code).toBe(1);
    expect((run.error as { message: string }).message).toContain('domain/index.ts');
    expect((run.error as { message: string }).message).toContain('"lodash"');
    expect(fetch.calls).toEqual([]);
  });
});
