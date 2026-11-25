import { createClient } from '@osdk/client';
import pg from 'pg';
import { inject, describe, expect, it, vi } from 'vitest';
import { run } from '../../cli/src/index.ts';
import { startLocalService } from '../testing/index.ts';
import { LOCAL_APP, localTwin, renamedTwin } from './localTwin.test-utils.ts';

const SLOW = { timeout: 120_000 };

const ACCOUNT = 'com.example.twin.Account';

async function ontologyRid(url: string, token: string): Promise<string> {
  const response = await fetch(`${url}/api/v2/ontologies`, { headers: { authorization: `Bearer ${token}` } });

  expect(response.status).toBe(200);

  const { data } = (await response.json()) as { data: { rid: string }[] };

  expect(data).toHaveLength(1);

  return data[0]?.rid ?? '';
}

describe('startLocalService', () => {
  it(
    'service/testing#local-service: publishes the app, installs it, and serves the stock client a read, a rule-backed apply, and a function-backed apply',
    SLOW,
    async () => {
      const local = await startLocalService({
        app: LOCAL_APP,
        folder: localTwin(),
        cli: run,
        postgres: inject('postgresAdminUrl'),
      });

      try {
        const rid = await ontologyRid(local.url, local.token);

        const client = createClient(local.url, rid, () => Promise.resolve(local.token));

        const action = (apiName: string) =>
          client({ type: 'action', apiName }) as {
            applyAction: (parameters: object, options?: object) => Promise<unknown>;
          };

        await action('com.example.twin.create-account').applyAction({
          accountId: 'local-1',
          name: 'Local',
          phase: 'customer',
        });

        expect(await accountIds(local.url, rid, local.token)).toEqual(['local-1']);

        const closed = await action('com.example.twin.close-account-action').applyAction(
          { account: 'local-1' },
          { $returnEdits: true },
        );

        expect(closed).toMatchObject({
          type: 'edits',
          modifiedObjects: [{ objectType: ACCOUNT, primaryKey: 'local-1' }],
        });
      } finally {
        await local.stop();
      }
    },
  );

  it(
    'service/testing#local-service: 2 starts at the same time on 1 Postgres each get their own port and database, and both serve',
    SLOW,
    async () => {
      const started = await Promise.allSettled([start(), start()]);

      const [a, b] = started.map((result) => (result.status === 'fulfilled' ? result.value : undefined));

      try {
        expect(started.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);

        if (a === undefined || b === undefined) return;

        expect(a.url).not.toBe(b.url);

        const [ridA, ridB] = await Promise.all([ontologyRid(a.url, a.token), ontologyRid(b.url, b.token)]);

        await createAccount(a.url, ridA, a.token, 'only-in-a');

        expect(await accountIds(a.url, ridA, a.token)).toEqual(['only-in-a']);

        expect(await accountIds(b.url, ridB, b.token)).toEqual([]);

        expect(await localDatabases()).toHaveLength(2);
      } finally {
        await Promise.all([a?.stop(), b?.stop()]);
      }

      expect(await localDatabases()).toEqual([]);
    },
  );

  it(
    'service/testing#local-service: 2 starts in 1 process with the same app and different Ontologies each serve their own Ontology',
    SLOW,
    async () => {
      const a = await start();

      try {
        const ridA = await ontologyRid(a.url, a.token);

        await createAccount(a.url, ridA, a.token, 'in-a');

        const b = await start({ folder: renamedTwin() });

        try {
          const ridB = await ontologyRid(b.url, b.token);

          expect([
            await applyStatus(b.url, ridB, b.token, 'make-account'),
            await applyStatus(b.url, ridB, b.token, 'create-account'),
          ]).toEqual([200, 404]);

          expect([
            await applyStatus(a.url, ridA, a.token, 'make-account'),
            await applyStatus(a.url, ridA, a.token, 'create-account'),
          ]).toEqual([404, 200]);
        } finally {
          await b.stop();
        }
      } finally {
        await a.stop();
      }
    },
  );

  it(
    'service/testing#local-service: the local service refuses a call off this computer, and the call never reaches the network',
    SLOW,
    async () => {
      const network = vi.spyOn(globalThis, 'fetch');

      try {
        const local = await start();

        try {
          const answer = await fetch(`${local.url}/multipass/api/oauth2/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=client_credentials',
          });

          await answer.text();

          expect(answer.status).toBe(503);

          await expect(fetch('https://example.com/')).rejects.toThrow(
            'The local Ontology service refused a call off this computer: https://example.com/',
          );
        } finally {
          await local.stop();
        }

        const sent = network.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));

        expect(sent.filter((url) => new URL(url).hostname !== '127.0.0.1')).toEqual([]);
      } finally {
        network.mockRestore();
      }
    },
  );

  it(
    'service/testing#local-service: the token is of a person with the role that the caller names, from the grants file',
    SLOW,
    async () => {
      const local = await start({ role: 'member' });

      try {
        const install = await fetch(`${local.url}/api/ontology-service/v1/ontologies`, {
          method: 'POST',
          headers: { authorization: `Bearer ${local.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ product: LOCAL_APP, apiName: 'second', displayName: 'second' }),
        });

        await install.text();

        expect(install.status).toBe(403);
      } finally {
        await local.stop();
      }
    },
  );

  it(
    'service/testing#local-service: a start with a role that the grants file does not hold fails, and leaves no database',
    SLOW,
    async () => {
      await expect(start({ role: 'owner' })).rejects.toThrow(
        'The grants file of twin has no role owner. Its roles: admin, member.',
      );

      expect(await localDatabases()).toEqual([]);
    },
  );

  it('service/testing#local-service: a start refuses a Postgres off this computer, also one that a host parameter names', async () => {
    await expect(start({ postgres: 'postgresql://postgres:x@db.example.com:5432/postgres' })).rejects.toThrow(
      'The local service takes only a Postgres on this computer, not db.example.com.',
    );

    await expect(
      start({ postgres: 'postgresql://postgres:x@127.0.0.1:61001/postgres?host=192.0.2.1' }),
    ).rejects.toThrow('The local service takes only a Postgres on this computer, not 192.0.2.1.');
  });

  it(
    'service/testing#local-service: a stop runs each step when 1 step fails, so the fetch guard goes off and the service closes',
    SLOW,
    async () => {
      const network = globalThis.fetch;

      const local = await start();

      const [name = ''] = await localDatabases();

      await asAdmin(`CREATE DATABASE ${name}_kept OWNER ${name}`);

      try {
        await expect(local.stop()).rejects.toThrow(`role "${name}" cannot be dropped`);

        expect(globalThis.fetch).toBe(network);

        await expect(fetch(`${local.url}/api/v2/ontologies`)).rejects.toThrow('fetch failed');
      } finally {
        await asAdmin(`DROP DATABASE ${name}_kept`);

        await asAdmin(`DROP ROLE ${name}`);
      }
    },
  );
});

const start = (options: { role?: string; postgres?: string; folder?: string } = {}) =>
  startLocalService({
    app: LOCAL_APP,
    folder: localTwin(),
    cli: run,
    postgres: inject('postgresAdminUrl'),
    ...options,
  });

async function asAdmin<Row extends pg.QueryResultRow>(text: string): Promise<Row[]> {
  const admin = new pg.Client({ connectionString: inject('postgresAdminUrl') });

  await admin.connect();

  try {
    return (await admin.query<Row>(text)).rows;
  } finally {
    await admin.end();
  }
}

const localDatabases = async (): Promise<string[]> =>
  (
    await asAdmin<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'local\\_%' ORDER BY datname",
    )
  ).map((row) => row.datname);

async function applyStatus(url: string, rid: string, token: string, action: string): Promise<number> {
  const answer = await fetch(`${url}/api/v2/ontologies/${rid}/actions/com.example.twin.${action}/apply`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      parameters: { accountId: `${action}-${crypto.randomUUID()}`, name: action, phase: 'customer' },
    }),
  });

  await answer.text();

  return answer.status;
}

async function createAccount(url: string, rid: string, token: string, accountId: string): Promise<void> {
  const answer = await fetch(`${url}/api/v2/ontologies/${rid}/actions/com.example.twin.create-account/apply`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ parameters: { accountId, name: accountId, phase: 'customer' } }),
  });

  await answer.text();

  expect(answer.status).toBe(200);
}

async function accountIds(url: string, rid: string, token: string): Promise<unknown[]> {
  const client = createClient(url, rid, () => Promise.resolve(token));

  const page = await client({ type: 'object', apiName: ACCOUNT }).fetchPage();

  await client.fetchMetadata({ type: 'object', apiName: ACCOUNT });

  return page.data.map((account) => account.$primaryKey);
}
