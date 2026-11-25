import { afterEach, describe, expect, it } from 'vitest';
import { NOTES_ONTOLOGY, notesApp } from './apps.test-utils.ts';
import { hashOf, NAME, stagingApp, withStaging } from './sdk/sdkPackage.test-utils.ts';
import { expectAllOnNewest, installGate, localGate, toLocal } from './sql.test-utils.ts';
import { cli, stubFetch, stubRegistry, type Handler } from './cli.test-utils.ts';

const PUBLISH_PATH = '/api/ontology-service/v1/publish';

const changedApp = (): string =>
  notesApp({
    '.ontology/deployment.json': JSON.stringify(withStaging()),
    'ontology/src/ontology.mts': NOTES_ONTOLOGY.replace(
      '    editsEnabled: true,\n',
      '    editsEnabled: true,\n    editsHistoryConfig: { enabled: true },\n',
    ),
  });

describe('path 5 of the model: the SDK package of an older version', () => {
  const local = localGate('production');

  afterEach(() => expectAllOnNewest(local.service));

  it('job B gets its answer of version 1 after request A stores version 2, and releases the package of version 1', async () => {
    const validated = await cli(['validate', ...local.flags()], {
      cwd: stagingApp(),
      fetch: stubFetch(toLocal),
      env: local.service.oidcEnv,
    });

    const hash = hashOf((validated.output as { metadata: unknown }).metadata);
    const registry = () => stubRegistry({ [NAME]: [{ version: '0.0.7', ontologyHash: hash }] });

    const first = await cli(['publish', ...local.flags()], {
      cwd: stagingApp(),
      fetch: stubFetch(toLocal),
      env: local.service.oidcEnv,
      registry: registry(),
    });

    expect([first.code, (first.output as { version: number }).version]).toEqual([0, 1]);

    await installGate(local.service);

    const answered = Promise.withResolvers<undefined>();
    const deliver = Promise.withResolvers<undefined>();

    const heldAnswer: Handler = async (call) => {
      const response = await toLocal(call);

      if (call.method === 'POST' && new URL(call.url).pathname === PUBLISH_PATH) {
        answered.resolve(undefined);

        await deliver.promise;
      }

      return response;
    };

    const packagesOfB = registry();

    const b = cli(['publish', ...local.flags()], {
      cwd: stagingApp(),
      fetch: stubFetch(heldAnswer),
      env: local.service.oidcEnv,
      registry: packagesOfB,
    });

    await answered.promise;

    const a = await cli(['publish', ...local.flags(), '--skip-sdk-package'], {
      cwd: changedApp(),
      fetch: stubFetch(toLocal),
      env: local.service.oidcEnv,
    });

    expect([a.code, (a.output as { version: number }).version]).toEqual([0, 2]);

    deliver.resolve(undefined);

    const run = await b;

    const versions = await local.service.query<{ version: number }>(
      'SELECT version FROM ontology_registry.product_versions ORDER BY version',
    );

    expect([run.code, (run.output as { version: number }).version, versions.map((row) => row.version)]).toEqual([
      0,
      1,
      [1, 2],
    ]);

    expect((run.output as { ontologySdk: unknown }).ontologySdk).toEqual({
      name: NAME,
      version: '0.0.7',
      ontologyHash: hash,
      action: 'tagged',
    });

    expect(packagesOfB.tags).toEqual([
      { name: NAME, version: '0.0.7', tag: 'production' },
      { name: NAME, version: '0.0.7', tag: 'latest' },
    ]);
  });
});
