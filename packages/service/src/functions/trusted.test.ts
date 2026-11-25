import { describe, expect, it } from 'vitest';
import { emptyDb, emptyDbs, TEST_READER, timeLeft, trustedSnapshot } from '../service.test-utils.ts';
import { settle } from '../errors/index.ts';
import { runFunction } from './index.ts';
import { handleTrusted, type Ctx, type HandleTrusted, type TrustedInput } from '../handler/index.ts';
import { emptyOntology, type CompiledOntology } from '../ontology/index.ts';
import { compileOrThrow, NS, ONTOLOGY_RID, stored } from '../ontology/stored.test-utils.ts';
import { actionOf, withFunctions } from './functions.test-utils.ts';
import { OrganizationId, UserId } from '../auth/caller.ts';

const ACCOUNT = `${NS}Account`;

const SOURCE = `
const Account = { type: 'object', apiName: '${ACCOUNT}' };
export const functions = {
  readName: async (client, accountId) => {
    await client(Account).fetchOne(accountId);
    return [];
  },
};
`;

describe('the Functions bridge', () => {
  it(
    'ontology/functions/functions#reads: each request of the client goes to handleTrusted ' +
      'with the snapshot of the run, the Ontology version of the Action, and the person who applies the Action',
    async () => {
      const { ir, functions } = await withFunctions(
        [{ apiName: 'readName', inputs: [{ name: 'accountId', type: 'string' }], edits: [ACCOUNT] }],
        SOURCE,
      );

      const ontology = compileOrThrow(stored(ir, { version: 7, functions }));
      const calls: { path: string; input: TrustedInput }[] = [];

      const recorder: HandleTrusted = (request, input) => {
        calls.push({ path: new URL(request.url).pathname, input });

        return Promise.resolve(new Response(null, { status: 404 }));
      };

      const caller = {
        user: UserId.parse('person-1'),
        kind: 'person' as const,
        organization: OrganizationId.parse('org_test'),
        permissions: [],
      };

      const checkWrite = timeLeft;

      const ctx: Ctx = {
        ...emptyDbs,
        reader: TEST_READER,
        ontology,
        caller,
        handleTrusted: recorder,
        log: () => undefined,
        checkWrite,
        traceDerived: () => undefined,
      };

      const snapshot = trustedSnapshot(emptyDb);
      const { actionType, fn } = functionOf(ontology, 'readName');

      expect((await settle(runFunction(fn, new Map([['accountId', 'acc-1']]), snapshot, ctx, actionType))).ok).toBe(
        false,
      );

      expect(calls.length).toBeGreaterThan(0);

      for (const { input } of calls) {
        expect(input.db).toBe(snapshot);
        expect(input.reader).toBe(ctx.reader);
        expect(input.ontology).toBe(ontology);
        expect(input.caller).toBe(caller);
        expect(input.checkWrite).toBe(checkWrite);
      }

      expect(calls[0]?.path).toMatch(/^\/api\/v2\/ontologies\/ri\.ontology\.main\.ontology\.[^/]+\//);
    },
  );

  it('gives the first 5xx of a client request as the cause of the 500, so the request log of the Action holds it', async () => {
    const { ir, functions } = await withFunctions(
      [{ apiName: 'readName', inputs: [{ name: 'accountId', type: 'string' }], edits: [ACCOUNT] }],
      SOURCE,
    );

    const ontology = compileOrThrow(stored(ir, { functions }));

    const recorder: HandleTrusted = () =>
      Promise.resolve(Response.json({ errorName: 'Default:Internal', errorInstanceId: 'inner-id' }, { status: 500 }));

    const ctx: Ctx = {
      ...emptyDbs,
      reader: TEST_READER,
      ontology,
      caller: {
        user: UserId.parse('person-1'),
        kind: 'person',
        organization: OrganizationId.parse('org_test'),
        permissions: [],
      },
      handleTrusted: recorder,
      log: () => undefined,
      checkWrite: timeLeft,
      traceDerived: () => undefined,
    };

    const { actionType, fn } = functionOf(ontology, 'readName');
    const run = runFunction(fn, new Map([['accountId', 'acc-1']]), trustedSnapshot(emptyDb), ctx, actionType);

    expect(await settle(run)).toMatchObject({
      ok: false,
      error: {
        kind: 'fault',
        error: {
          message: "A request of the Function's client got a 5xx, so the run gets 500.",
          cause: {
            message: expect.stringMatching(/^GET \/api\/v2\/ontologies\/\S+ got 500: .*"errorInstanceId":"inner-id"/),
          },
        },
      },
    });
  });
});

function functionOf(ontology: CompiledOntology, apiName: string) {
  const actionType = ontology.actionTypes.get(actionOf(apiName));
  const fn = actionType?.logic.kind === 'function' ? ontology.functions.get(actionType.logic.function) : undefined;

  if (!actionType || fn?.kind !== 'edit') throw new Error('The test Action has no edit Function.');

  return { actionType, fn };
}

describe('a request of a Function client outside the reads of its own Ontology', () => {
  const input: TrustedInput = {
    db: trustedSnapshot(emptyDb),
    reader: TEST_READER,
    ontology: emptyOntology(ONTOLOGY_RID),
    caller: {
      user: UserId.parse('person-1'),
      kind: 'person',
      organization: OrganizationId.parse('org_test'),
      permissions: [],
    },
    checkWrite: timeLeft,
  };

  const send = async (method: 'GET' | 'POST', path: string) => {
    const response = await handleTrusted(
      new Request(`https://ontology-service.invalid${path}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) }),
      input,
    );

    const { errorInstanceId, ...body } = (await response.json()) as Record<string, unknown>;

    return [response.status, body, typeof errorInstanceId];
  };

  it('ontology/functions/functions#reads: handleTrusted answers a write and each route outside the Ontology routes with 403 Default:PermissionDenied', async () => {
    const denied = [
      403,
      { errorCode: 'PERMISSION_DENIED', errorName: 'Default:PermissionDenied', parameters: {} },
      'string',
    ];

    const requests: ['GET' | 'POST', string][] = [
      ['POST', '/api/ontology-service/v1/publish'],
      ['POST', `/api/v2/ontologies/${ONTOLOGY_RID}/actions/${NS}create-account/apply`],
      ['POST', `/api/v2/ontologies/${ONTOLOGY_RID}/actions/${NS}create-account/applyBatch`],
      ['GET', '/api/v2/ontologies'],
      ['POST', '/api/ontology-service/v1/ontologies'],
      ['GET', '/api/v2/admin/users/getCurrent'],
      ['GET', '/api/v2/admin/users/person-2'],
      ['POST', '/api/v2/admin/users/getBatch'],
      ['GET', '/api/ontology-service/v1/organizations'],
      ['POST', '/api/mcp'],
      ['GET', '/api/mcp'],
      ['GET', '/api/ontology-service/v1/client-config'],
      ['GET', '/api/oauth-protected-resource'],
    ];

    for (const [method, path] of requests) expect([path, ...(await send(method, path))]).toEqual([path, ...denied]);
  });

  it('ontology/functions/functions#reads: handleTrusted serves the metadata reads of its own Ontology', async () => {
    for (const path of [
      `/api/v2/ontologies/${ONTOLOGY_RID}/objectTypes`,
      `/api/v2/ontologies/${ONTOLOGY_RID}/actionTypes`,
    ]) {
      const response = await handleTrusted(new Request(`https://ontology-service.invalid${path}`), input);

      expect([path, response.status]).toEqual([path, 200]);
    }
  });

  it('ontology/functions/functions#reads: handleTrusted answers a read on another Ontology with 404 OntologyNotFound, and a write on it with 403', async () => {
    const other = 'ri.ontology.main.ontology.00000000-0000-4000-8000-000000000627';

    expect(await send('GET', `/api/v2/ontologies/${other}/objectTypes`)).toEqual([
      404,
      { errorCode: 'NOT_FOUND', errorName: 'OntologyNotFound', parameters: { ontologyRid: other } },
      'string',
    ]);

    expect(await send('POST', `/api/v2/ontologies/${other}/actions/${NS}create-account/apply`)).toEqual([
      403,
      { errorCode: 'PERMISSION_DENIED', errorName: 'Default:PermissionDenied', parameters: {} },
      'string',
    ]);
  });
});
