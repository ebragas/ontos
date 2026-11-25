import { describe, expect, it } from 'vitest';
import { TWIN_FUNCTIONS, twinFunction, twinFunctionsApp } from './apps.test-utils.ts';
import { cli, once, stubFetch, withoutDescriptionWarnings } from './cli.test-utils.ts';
import { localGate, installGate, personEnv, toLocal } from './sql.test-utils.ts';

const local = localGate();

describe('publish with Functions against node.ts', () => {
  it('service/cli#inputs, ontology/functions/functions#discovery: publish sends the discovered Functions and the Function bundle, and the service runs a Function of the bundle', async () => {
    const fetch = stubFetch(toLocal);

    const run = await cli(['publish', ...local.flags()], {
      cwd: twinFunctionsApp(),
      fetch,
      env: local.service.oidcEnv,
    });

    expect(withoutDescriptionWarnings(run.stderr)).toBe('');
    expect(run.code).toBe(0);
    expect((run.output as { version: number }).version).toBe(1);

    const body = JSON.parse(
      fetch.calls.find(({ url }) => url.endsWith('/api/ontology-service/v1/publish'))?.body ?? '{}',
    ) as {
      functions: { discovered: { locator: { typescript: { functionName: string } } }[]; bundle: string };
    };

    expect(body.functions.discovered.map((fn) => fn.locator.typescript.functionName)).toEqual([...TWIN_FUNCTIONS]);

    await installGate(local.service);

    const env = await personEnv(local.service);

    const created = await cli(
      [
        'apply',
        'com.example.twin.create-account',
        '--parameters',
        '{"accountId":"acc-cli","name":"CLI"}',
        ...local.flags(),
      ],
      { fetch: globalThis.fetch, env },
    );

    expect(created.stderr).toBe('');

    expect((created.output as { addedObjects: unknown }).addedObjects).toEqual([
      { objectType: 'com.example.twin.Account', primaryKey: 'acc-cli' },
    ]);

    const closed = await cli(
      ['apply', 'com.example.twin.close-account-action', '--parameters', '{"account":"acc-cli"}', ...local.flags()],
      { fetch: globalThis.fetch, env },
    );

    expect(closed.stderr).toBe('');
    expect(closed.code).toBe(0);

    expect((closed.output as { modifiedObjects: unknown }).modifiedObjects).toEqual([
      { objectType: 'com.example.twin.Account', primaryKey: 'acc-cli' },
    ]);

    const read = await cli(
      ['objects', 'com.example.twin.Account', 'acc-cli', '--select', '["phase"]', ...local.flags()],
      { fetch: globalThis.fetch, env },
    );

    expect((read.output as { phase: string }).phase).toBe('closed');
  });

  const described = once(async () => {
    const doc =
      '/**\n * Closes the account.\n * @param reason - Why the account closes.\n */\nexport default async function closeAccount(';

    const source = twinFunction('closeAccount').replace('export default async function closeAccount(', doc);
    const fetch = stubFetch(toLocal);

    const published = await cli(['publish', ...local.flags()], {
      cwd: twinFunctionsApp({ 'functions/typescript-functions/src/functions/closeAccount.ts': source }),
      fetch,
      env: local.service.oidcEnv,
    });

    expect(withoutDescriptionWarnings(published.stderr)).toBe('');

    const body = JSON.parse(
      fetch.calls.find(({ url }) => url.endsWith('/api/ontology-service/v1/publish'))?.body ?? '{}',
    ) as { functions: { discovered: { locator: { typescript: { functionName: string } }; documentation?: string }[] } };

    await installGate(local.service);

    const run = await cli(['describe', 'com.example.twin.close-account-action', ...local.flags()], {
      fetch: globalThis.fetch,
      env: await personEnv(local.service),
    });

    expect(withoutDescriptionWarnings(run.stderr)).toBe('');

    const sent = body.functions.discovered.find((fn) => fn.locator.typescript.functionName === 'closeAccount');

    return {
      ...(run.output as { actionType: { description?: string; parameters: Record<string, { description?: string }> } })
        .actionType,
      sentDocumentation: sent?.documentation,
    };
  });

  it('ontology/functions/functions#discovery/10739002: a @param tag gives the description of the input, and the route gives it as ActionParameterV2.description', async () => {
    const actionType = await described();

    expect(actionType.parameters['reason']?.description).toBe('Why the account closes.');
    expect(actionType.parameters['account']).not.toHaveProperty('description');
  });

  it('ontology/functions/functions#discovery/530e0671: a doc comment does not change the Action Type description', async () => {
    const actionType = await described();

    expect(actionType.sentDocumentation).toBe('Closes the account.');
    expect(actionType).not.toHaveProperty('description');
  });

  it.each([
    ['void', 'Promise<void>', 'void'],
    ['Long', 'Promise<Long>', 'long'],
    ['Float', 'Promise<Float>', 'float'],
    ['Object Set', 'Promise<ObjectSet<Account>>', 'objectSet'],
  ])(
    'ontology/functions/query-functions#outputs: a %s output stops validate and publish with the compile text that names the type and the Function',
    async (_name, returns, kind) => {
      const source = `import type { Client, ObjectSet } from "@osdk/client";\nimport type { Long, Float } from "@osdk/functions";\nimport { Account } from "@ontology/sdk";\nexport default async function refused(client: Client): ${returns} {\n  throw new Error("x");\n}\n`;
      const cwd = twinFunctionsApp({ 'functions/typescript-functions/src/functions/refused.ts': source });
      const text = `Function refused has the output type ${kind}, which a Query Function does not have. A Query Function returns a String, a Boolean, an Integer, a Double, a Date, a Timestamp, a Decimal, an Object, a struct, or a list of these, or T | undefined.`;

      for (const command of ['validate', 'publish']) {
        const run = await cli([command, ...local.flags()], {
          cwd,
          fetch: stubFetch(toLocal),
          env: local.service.oidcEnv,
        });

        expect([run.code, withoutDescriptionWarnings(run.stderr)]).toEqual([1, expect.stringContaining(text)]);
      }
    },
  );

  it('ontology/ontology-sdk/ontology-sdk#contract: a Function that imports from domain/ bundles cleanly, publishes, and runs in the worker', async () => {
    const source = [
      'import { CLOSED_PHASE } from "../../../../domain/index.ts";',
      twinFunction('closeAccount').replace("phase: 'closed'", 'phase: CLOSED_PHASE'),
    ].join('\n');

    const cwd = twinFunctionsApp({
      'domain/index.ts': "export * from './phases.ts';\n",
      'domain/phases.ts': "export const CLOSED_PHASE = 'closed';\n",
      'functions/typescript-functions/src/functions/closeAccount.ts': source,
    });

    const fetch = stubFetch(toLocal);

    const published = await cli(['publish', ...local.flags()], { cwd, fetch, env: local.service.oidcEnv });

    expect([published.code, withoutDescriptionWarnings(published.stderr)]).toEqual([0, '']);

    await installGate(local.service);

    const env = await personEnv(local.service);

    const created = await cli(
      [
        'apply',
        'com.example.twin.create-account',
        '--parameters',
        '{"accountId":"acc-domain","name":"Domain"}',
        ...local.flags(),
      ],
      { fetch: globalThis.fetch, env },
    );

    expect([created.code, created.stderr]).toEqual([0, '']);

    const closed = await cli(
      ['apply', 'com.example.twin.close-account-action', '--parameters', '{"account":"acc-domain"}', ...local.flags()],
      { fetch: globalThis.fetch, env },
    );

    expect([closed.code, closed.stderr]).toEqual([0, '']);

    const read = await cli(
      ['objects', 'com.example.twin.Account', 'acc-domain', '--select', '["phase"]', ...local.flags()],
      { fetch: globalThis.fetch, env },
    );

    expect((read.output as { phase: string }).phase).toBe('closed');
  });
});
