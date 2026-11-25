import { afterEach, describe, expect, it } from 'vitest';
import { TEST_APP } from '../../../tools/packaging/testService.ts';
import { notesApp, OSDK_SET, twinApp, twinGrants, twinIr } from './apps.test-utils.ts';
import { cli, stubFetch, withoutDescriptionWarnings } from './cli.test-utils.ts';
import { expectAllOnNewest, localGate, installGate, notesUsers, personEnv, toLocal } from './sql.test-utils.ts';

const local = localGate('production', notesUsers());

afterEach(() => expectAllOnNewest(local.service));

function publishBodies(calls: readonly { url: string; body: string | undefined }[]): unknown[] {
  return calls
    .filter(({ url }) => url === `${local.service.url}/api/ontology-service/v1/publish`)
    .map(({ body }) => JSON.parse(body ?? 'null'));
}

describe('validate and publish against node.ts', () => {
  it("service/cli#commands, service/cli#inputs, service/publish#when, service/publish#what-the-app-publishes: validate runs the app's @osdk/maker on ontology/src/ontology.mts with the apiNamespace of foundry.yml, and sends the publish route with validateOnly and the product, the app name", async () => {
    const fetch = stubFetch(toLocal);

    const run = await cli(['validate', ...local.flags()], { cwd: twinApp(), fetch, env: local.service.oidcEnv });

    const skipped =
      'com.example.twin.close-account-action, com.example.twin.probe-version-check-action, com.example.twin.set-relationship-action';

    expect(withoutDescriptionWarnings(run.stderr)).toBe(
      `${JSON.stringify({ warning: `The grants check did not run the default role rule for these function-backed Action Types, because the request has no Functions: ${skipped}.` })}\n`,
    );

    expect(run.code).toBe(0);

    expect(publishBodies(fetch.calls)).toEqual([
      {
        ir: twinIr('0.7.0'),
        product: 'app',
        schemaMigrations: { migrations: [] },
        osdkSet: OSDK_SET,
        grants: JSON.parse(twinGrants('0.7.0')),
        validateOnly: true,
      },
    ]);

    const answer = run.output as {
      changes: unknown[];
      metadata: { ontology: { rid: string }; objectTypes: Record<string, unknown> };
      version?: number;
    };

    expect(answer.version).toBeUndefined();
    expect(answer.metadata.ontology.rid).toBe(TEST_APP.productRid);

    expect(Object.keys(answer.metadata.objectTypes).sort()).toEqual([
      'com.example.twin.Account',
      'com.example.twin.Engagement',
      'com.example.twin.StructProbe',
    ]);

    const read = await cli(['describe', ...local.flags()], {
      fetch: globalThis.fetch,
      env: await personEnv(local.service),
    });

    expect(read.error).toEqual({
      message:
        'The Organization has no Ontology. An admin of the Organization must install one: ontos install <product> --api-name <name> --display-name <name>',
    });
  });

  it('service/publish#what-the-app-publishes: each publish names the OSDK set of the installed packages', async () => {
    const fetch = stubFetch(toLocal);

    await cli(['validate', ...local.flags()], { cwd: notesApp(), fetch, env: local.service.oidcEnv });

    expect((publishBodies(fetch.calls)[0] as { osdkSet: unknown }).osdkSet).toEqual(OSDK_SET);
  });

  it('ontology/object-edits/schema-migrations#the-schema-migrations-file: the CLI reads .ontology/schema-migrations.json at the root of the app, and sends it', async () => {
    const migrations = { migrations: [{ type: 'dropAllPatches', objectType: 'com.example.notes.Gone' }] };
    const fetch = stubFetch(toLocal);

    await cli(['validate', ...local.flags()], {
      cwd: notesApp({ '.ontology/schema-migrations.json': JSON.stringify(migrations) }),
      fetch,
      env: local.service.oidcEnv,
    });

    expect((publishBodies(fetch.calls)[0] as { schemaMigrations: unknown }).schemaMigrations).toEqual(migrations);

    const empty = stubFetch(toLocal);

    const none = await cli(['validate', ...local.flags()], {
      cwd: notesApp({ '.ontology/schema-migrations.json': '' }),
      env: local.service.oidcEnv,
      fetch: empty,
    });

    expect(none.code).toBe(1);

    expect(none.error).toEqual({
      message: '.ontology/schema-migrations.json is not JSON: Unexpected end of JSON input',
    });

    expect(publishBodies(empty.calls)).toEqual([]);
  });

  it("service/cli#commands: publish applies the publish, for the app's publish workflow, and gives the new Ontology version", async () => {
    const fetch = stubFetch(toLocal);

    const run = await cli(['publish', ...local.flags()], { cwd: notesApp(), fetch, env: local.service.oidcEnv });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);

    const [body] = publishBodies(fetch.calls) as {
      ir: { ontology: { objectTypes: Record<string, unknown> } };
      validateOnly: boolean;
    }[];

    expect(body?.validateOnly).toBe(false);
    expect(Object.keys(body?.ir.ontology.objectTypes ?? {})).toEqual(['com.example.notes.Note']);

    const answer = run.output as {
      version: number;
      changes: unknown[];
      metadata: { objectTypes: Record<string, unknown> };
    };

    expect(answer.version).toBe(1);
    expect(Object.keys(answer.metadata.objectTypes)).toEqual(['com.example.notes.Note']);

    await installGate(local.service);

    const read = await cli(['describe', ...local.flags()], {
      fetch: globalThis.fetch,
      env: await personEnv(local.service),
    });

    expect((read.output as { objectTypes: { apiName: string }[] }).objectTypes.map(({ apiName }) => apiName)).toEqual([
      'com.example.notes.Note',
    ]);

    const again = await cli(['publish', ...local.flags()], {
      cwd: notesApp(),
      fetch: stubFetch(toLocal),
      env: local.service.oidcEnv,
    });

    expect((again.output as { version: number; changes: unknown[] }).version).toBe(1);
    expect((again.output as { changes: unknown[] }).changes).toEqual([]);
  });
});
