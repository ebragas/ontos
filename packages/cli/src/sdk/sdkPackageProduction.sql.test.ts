import { describe, expect, it } from 'vitest';
import { GATE_DEPLOYMENT_FILE, notesApp } from '../apps.test-utils.ts';
import { hashOf, NAME, stagingApp, withStaging } from './sdkPackage.test-utils.ts';
import { localGate, toLocal } from '../sql.test-utils.ts';
import { cli, stubFetch, stubRegistry } from '../cli.test-utils.ts';

describe('the Ontology SDK package of a production publish', () => {
  const local = localGate('production');

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: a production publish moves the tags production and latest to the version with the ontologyHash of the current Ontology, and publishes no version', async () => {
    const validated = await cli(['validate', ...local.flags()], {
      cwd: stagingApp(),
      fetch: stubFetch(toLocal),
      env: local.service.oidcEnv,
    });

    const hash = hashOf((validated.output as { metadata: unknown }).metadata);

    const registry = stubRegistry({
      [NAME]: [
        { version: '0.0.3', ontologyHash: 'a'.repeat(64) },
        { version: '0.0.7', ontologyHash: hash },
        { version: '0.0.9', ontologyHash: 'b'.repeat(64) },
      ],
    });

    const run = await cli(['publish', ...local.flags()], {
      cwd: stagingApp(),
      fetch: stubFetch(toLocal),
      env: { ...local.service.oidcEnv, GITHUB_RUN_NUMBER: '20' },
      registry,
    });

    expect(run.stderr).toBe('');

    expect((run.output as { ontologySdk: unknown }).ontologySdk).toEqual({
      name: NAME,
      version: '0.0.7',
      ontologyHash: hash,
      action: 'tagged',
    });

    expect(registry.tags).toEqual([
      { name: NAME, version: '0.0.7', tag: 'production' },
      { name: NAME, version: '0.0.7', tag: 'latest' },
    ]);

    expect(registry.published).toEqual([]);
  });

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: a production publish finds the version by the hash of the current environments, so a version made with an old WorkOS client ID does not match', async () => {
    const validated = await cli(['validate', ...local.flags()], {
      cwd: stagingApp(),
      fetch: stubFetch(toLocal),
      env: local.service.oidcEnv,
    });

    const { metadata } = validated.output as { metadata: unknown };

    const registry = stubRegistry({
      [NAME]: [
        { version: '0.0.4', ontologyHash: hashOf(metadata) },
        { version: '0.0.5', ontologyHash: hashOf(metadata, withStaging('client_staging_2')) },
      ],
    });

    const current = await cli(['publish', ...local.flags()], {
      cwd: stagingApp('client_staging_2'),
      fetch: stubFetch(toLocal),
      env: local.service.oidcEnv,
      registry,
    });

    expect(current.stderr).toBe('');

    expect((current.output as { ontologySdk: unknown }).ontologySdk).toEqual({
      name: NAME,
      version: '0.0.5',
      ontologyHash: hashOf(metadata, withStaging('client_staging_2')),
      action: 'tagged',
    });

    const old = await cli(['publish', ...local.flags()], {
      cwd: stagingApp(),
      fetch: stubFetch(toLocal),
      env: local.service.oidcEnv,
      registry: stubRegistry({
        [NAME]: [{ version: '0.0.5', ontologyHash: hashOf(metadata, withStaging('client_staging_2')) }],
      }),
    });

    expect(old.code).toBe(1);
    expect((JSON.parse(old.stderr) as { message: string }).message).toContain(hashOf(metadata));
  });

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: a production publish fails, and names the hash, when no version has it', async () => {
    const registry = stubRegistry({ [NAME]: [{ version: '0.0.3', ontologyHash: 'a'.repeat(64) }] });

    const run = await cli(['publish', ...local.flags()], {
      cwd: stagingApp(),
      fetch: stubFetch(toLocal),
      env: local.service.oidcEnv,
      registry,
    });

    expect(run.code).toBe(1);

    const message = (JSON.parse(run.stderr) as { message: string }).message;

    expect(message).toMatch(
      /^No version of @ontos\/app-ontology-sdk has the ontologyHash [0-9a-f]{64} of the current Ontology version of production\. Publish the Ontology to staging first\.$/,
    );

    expect(registry.tags).toEqual([]);
  });

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: a deployment with no staging environment, such as gate, publishes no package and moves no tag', async () => {
    const registry = stubRegistry();

    const run = await cli(['publish', ...local.flags()], {
      cwd: notesApp({ '.ontology/deployment.json': GATE_DEPLOYMENT_FILE }),
      fetch: stubFetch(toLocal),
      env: { ...local.service.oidcEnv, GITHUB_RUN_NUMBER: '30' },
      registry,
    });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect((run.output as Record<string, unknown>)['ontologySdk']).toBeUndefined();
    expect(registry.published).toEqual([]);
    expect(registry.tags).toEqual([]);
  });

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: a production publish with domain/ moves production and latest to the version whose hash includes domain/, and fails when domain/ differs', async () => {
    const domainIndex = "export const UNIT = 'cents';\n";

    const validated = await cli(['validate', ...local.flags()], {
      cwd: stagingApp(undefined, { 'domain/index.ts': domainIndex }),
      fetch: stubFetch(toLocal),
      env: local.service.oidcEnv,
    });

    const { metadata } = validated.output as { metadata: unknown };
    const hash = hashOf(metadata, withStaging(), [{ path: 'index.ts', bytes: Buffer.from(domainIndex) }]);
    const registry = stubRegistry({ [NAME]: [{ version: '0.0.12', ontologyHash: hash }] });

    const ok = await cli(['publish', ...local.flags()], {
      cwd: stagingApp(undefined, { 'domain/index.ts': domainIndex }),
      fetch: stubFetch(toLocal),
      env: local.service.oidcEnv,
      registry,
    });

    expect([ok.code, ok.stderr]).toEqual([0, '']);

    expect((ok.output as { ontologySdk: unknown }).ontologySdk).toEqual({
      name: NAME,
      version: '0.0.12',
      ontologyHash: hash,
      action: 'tagged',
    });

    expect(registry.tags).toEqual([
      { name: NAME, version: '0.0.12', tag: 'production' },
      { name: NAME, version: '0.0.12', tag: 'latest' },
    ]);

    const changed = await cli(['publish', ...local.flags()], {
      cwd: stagingApp(undefined, { 'domain/index.ts': "export const UNIT = 'dollars';\n" }),
      fetch: stubFetch(toLocal),
      env: local.service.oidcEnv,
      registry: stubRegistry({ [NAME]: [{ version: '0.0.12', ontologyHash: hash }] }),
    });

    expect(changed.code).toBe(1);

    expect((JSON.parse(changed.stderr) as { message: string }).message).toContain(
      hashOf(metadata, withStaging(), [{ path: 'index.ts', bytes: Buffer.from("export const UNIT = 'dollars';\n") }]),
    );
  });
});
