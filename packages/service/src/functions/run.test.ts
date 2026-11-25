import { describe, expect, it } from 'vitest';
import { OrganizationId, UserId } from '../auth/caller.ts';
import { settle } from '../errors/index.ts';
import type { Ctx, HandleTrusted } from '../handler/index.ts';
import type { CompiledOntology } from '../ontology/index.ts';
import type { PublishedFunctions } from '../publish/index.ts';
import { NS } from '../ontology/stored.test-utils.ts';
import { convert } from '../metadata.test-utils.ts';
import { emptyDb, emptyDbs, TEST_READER, timeLeft, trustedSnapshot } from '../service.test-utils.ts';
import { actionOf, withFunctions } from './functions.test-utils.ts';
import { callFunction } from './pool.ts';
import { clientKeyOf, runFunction } from './run.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Account = { type: 'object', apiName: '${ACCOUNT}' };
const Engagement = { type: 'object', apiName: '${ENGAGEMENT}' };
const thread = () => process.getBuiltinModule('node:worker_threads').threadId;

async function readMetadata(client, objectType) {
  try {
    const meta = await client.fetchMetadata(objectType);
    return {
      ok: true,
      displayName: meta.displayName,
      links: Object.keys(meta.links ?? {}).sort(),
      properties: Object.keys(meta.properties ?? {}).sort(),
    };
  } catch (error) {
    const answer = error.cause ?? error;
    return { ok: false, statusCode: answer.statusCode, errorName: answer.errorName };
  }
}

export const functions = {
  readBoth: async (client, label) => {
    const account = await client(Account).fetchOne('acc-1');
    const engagement = await client(Engagement).fetchOne('eng-1');
    const batch = createEditBatch(client);
    batch.create(Account, {
      accountId: label,
      name: JSON.stringify({ thread: thread(), accountName: account.name, engagementTitle: engagement.title }),
    });
    return batch.getEdits();
  },
  inspectMetadata: async (client, label) => {
    const account = await readMetadata(client, Account);
    const engagement = await readMetadata(client, Engagement);
    const batch = createEditBatch(client);
    batch.create(Engagement, {
      engagementId: label,
      title: JSON.stringify({ thread: thread(), account, engagement }),
    });
    return batch.getEdits();
  },
};
`;

function compiledWithMetadata(
  ir: Parameters<typeof convert>[0],
  functions: PublishedFunctions,
  version: number,
): CompiledOntology {
  const converted = convert(ir, { functions, version });

  return { ...converted.compiled, metadata: converted.metadata };
}

function functionOf(ontology: CompiledOntology, apiName: string) {
  const actionType = ontology.actionTypes.get(actionOf(apiName));
  const fn = actionType?.logic.kind === 'function' ? ontology.functions.get(actionType.logic.function) : undefined;

  if (!actionType || fn?.kind !== 'edit') throw new Error(`Missing test edit Function ${apiName}.`);

  return { actionType, fn };
}

function recordingTrusted(objects: Readonly<Record<string, Record<string, unknown>>>): {
  readonly handleTrusted: HandleTrusted;
  readonly paths: string[];
  readonly fullMetadataPaths: () => string[];
} {
  const paths: string[] = [];

  const handleTrusted: HandleTrusted = (request, input) => {
    const { pathname } = new URL(request.url);

    paths.push(pathname);

    const metaMatch = /^\/api\/v2\/ontologies\/[^/]+\/objectTypes\/([^/]+)\/fullMetadata$/.exec(pathname);

    if (metaMatch) {
      const objectType = decodeURIComponent(metaMatch[1] ?? '');

      const metadata = Object.hasOwn(input.ontology.metadata.objectTypes, objectType)
        ? input.ontology.metadata.objectTypes[objectType]
        : undefined;

      if (!metadata) {
        return Promise.resolve(
          Response.json(
            {
              errorCode: 'NOT_FOUND',
              errorName: 'ObjectTypeNotFound',
              errorInstanceId: 'meta-404',
              parameters: { objectType },
            },
            { status: 404 },
          ),
        );
      }

      return Promise.resolve(Response.json(metadata));
    }

    const singleMatch = /^\/api\/v2\/ontologies\/[^/]+\/objects\/([^/]+)\/([^/]+)$/.exec(pathname);

    if (singleMatch) {
      const objectType = decodeURIComponent(singleMatch[1] ?? '');
      const row = objects[objectType];

      return Promise.resolve(row ? Response.json(row) : new Response(null, { status: 404 }));
    }

    if (pathname.endsWith('/objectSets/loadObjects')) {
      return request.json().then((body) => {
        const objectSet = (body as { objectSet?: { objectType?: string; objectSet?: { objectType?: string } } })
          .objectSet;

        const objectType = objectSet?.objectType ?? objectSet?.objectSet?.objectType ?? '';
        const row = objects[objectType];

        return Response.json({ data: row ? [row] : [], totalCount: row ? '1' : '0' });
      });
    }

    return Promise.resolve(new Response(null, { status: 404 }));
  };

  return {
    handleTrusted,
    paths,
    fullMetadataPaths: () => paths.filter((path) => path.includes('/fullMetadata')),
  };
}

function makeCtx(ontology: CompiledOntology, handleTrusted: HandleTrusted, organization = 'org_test'): Ctx {
  return {
    ...emptyDbs,
    reader: TEST_READER,
    ontology,
    caller: {
      user: UserId.parse('person-1'),
      kind: 'person',
      organization: OrganizationId.parse(organization),
      permissions: [],
    },
    handleTrusted,
    log: () => undefined,
    checkWrite: timeLeft,
    traceDerived: () => undefined,
  };
}

function engagementOnly(ontology: CompiledOntology): CompiledOntology {
  const engagementMeta = ontology.metadata.objectTypes[ENGAGEMENT];

  if (!engagementMeta) throw new Error('Missing Engagement metadata.');

  return {
    ...ontology,
    metadata: {
      ...ontology.metadata,
      objectTypes: {
        [ENGAGEMENT]: { ...engagementMeta, linkTypes: [] },
      },
    },
  };
}

describe('Function worker @osdk/client reuse and isolation', () => {
  it('reuses cached @osdk/client metadata on warm worker: Call 1 fetches fullMetadata, Call 2 fires zero fullMetadata calls while reading fresh data', async () => {
    const { ir, functions } = await withFunctions(
      [{ apiName: 'readBoth', inputs: [{ name: 'label', type: 'string' }], edits: [ACCOUNT] }],
      SOURCE,
    );

    const ontology = compiledWithMetadata(ir, functions, 1);
    const { actionType, fn } = functionOf(ontology, 'readBoth');
    const snapshot = trustedSnapshot(emptyDb);

    const firstRecorder = recordingTrusted({
      [ACCOUNT]: { __apiName: ACCOUNT, __primaryKey: 'acc-1', accountId: 'acc-1', name: 'Acme v1' },
      [ENGAGEMENT]: { __apiName: ENGAGEMENT, __primaryKey: 'eng-1', engagementId: 'eng-1', title: 'Audit v1' },
    });

    const first = await settle(
      runFunction(
        fn,
        new Map([['label', 'call-1']]),
        snapshot,
        makeCtx(ontology, firstRecorder.handleTrusted),
        actionType,
      ),
    );

    expect(first.ok).toBe(true);

    if (!first.ok) return;

    expect(firstRecorder.fullMetadataPaths()).toHaveLength(2);

    const textProperty = (
      edits: readonly { readonly type: string; readonly properties?: ReadonlyMap<string, unknown> }[],
      key: string,
    ): string => {
      const value = edits[0]?.type === 'addObject' ? edits[0].properties?.get(key) : '';

      return typeof value === 'string' ? value : JSON.stringify(value ?? '');
    };

    const firstPayload = JSON.parse(textProperty(first.value, 'name')) as {
      thread: number;
      accountName: string;
      engagementTitle: string;
    };

    expect(firstPayload.accountName).toBe('Acme v1');
    expect(firstPayload.engagementTitle).toBe('Audit v1');

    const secondRecorder = recordingTrusted({
      [ACCOUNT]: { __apiName: ACCOUNT, __primaryKey: 'acc-1', accountId: 'acc-1', name: 'Acme v2' },
      [ENGAGEMENT]: { __apiName: ENGAGEMENT, __primaryKey: 'eng-1', engagementId: 'eng-1', title: 'Audit v2' },
    });

    const second = await settle(
      runFunction(
        fn,
        new Map([['label', 'call-2']]),
        snapshot,
        makeCtx(ontology, secondRecorder.handleTrusted),
        actionType,
      ),
    );

    expect(second.ok).toBe(true);

    if (!second.ok) return;

    const secondPayload = JSON.parse(textProperty(second.value, 'name')) as {
      thread: number;
      accountName: string;
      engagementTitle: string;
    };

    expect(secondPayload.thread).toBe(firstPayload.thread);
    expect(secondRecorder.fullMetadataPaths()).toEqual([]);
    expect(secondPayload.accountName).toBe('Acme v2');
    expect(secondPayload.engagementTitle).toBe('Audit v2');
  });

  it('never leaks cached fullMetadata across callers with different permissions on the same warm worker', async () => {
    const { ir, functions } = await withFunctions(
      [{ apiName: 'inspectMetadata', inputs: [{ name: 'label', type: 'string' }], edits: [ENGAGEMENT] }],
      SOURCE,
    );

    const adminOntology = compiledWithMetadata(ir, functions, 1);
    const memberOntology = engagementOnly(adminOntology);
    const { actionType, fn } = functionOf(adminOntology, 'inspectMetadata');
    const snapshot = trustedSnapshot(emptyDb);

    const adminRec = recordingTrusted({});

    const adminRun = await settle(
      runFunction(
        fn,
        new Map([['label', 'admin-1']]),
        snapshot,
        makeCtx(adminOntology, adminRec.handleTrusted),
        actionType,
      ),
    );

    expect(adminRun.ok).toBe(true);

    if (!adminRun.ok) return;

    const rawTitle = (
      edits: readonly { readonly type: string; readonly properties?: ReadonlyMap<string, unknown> }[],
    ): string => {
      const value = edits[0]?.type === 'addObject' ? edits[0].properties?.get('title') : '';

      return typeof value === 'string' ? value : '';
    };

    const adminFact = JSON.parse(rawTitle(adminRun.value)) as {
      thread: number;
      account: { ok: boolean; links?: string[] };
      engagement: { ok: boolean; links?: string[] };
    };

    expect(adminFact.account.ok).toBe(true);
    expect(adminFact.engagement.ok).toBe(true);
    expect(adminFact.engagement.links).toContain('account');
    expect(adminRec.fullMetadataPaths()).toHaveLength(2);

    const memberRec1 = recordingTrusted({});

    const memberRun1 = await settle(
      runFunction(
        fn,
        new Map([['label', 'member-1']]),
        snapshot,
        makeCtx(memberOntology, memberRec1.handleTrusted),
        actionType,
      ),
    );

    expect(memberRun1.ok).toBe(true);

    if (!memberRun1.ok) return;

    const memberFact1 = JSON.parse(rawTitle(memberRun1.value)) as {
      thread: number;
      account: { ok: boolean; statusCode?: number; errorName?: string };
      engagement: { ok: boolean; links?: string[] };
    };

    expect(memberFact1.thread).toBe(adminFact.thread);
    expect(memberFact1.account).toEqual({ ok: false, statusCode: 404, errorName: 'ObjectTypeNotFound' });
    expect(memberFact1.engagement.ok).toBe(true);
    expect(memberFact1.engagement.links).toEqual([]);

    const memberRec2 = recordingTrusted({});

    const memberRun2 = await settle(
      runFunction(
        fn,
        new Map([['label', 'member-2']]),
        snapshot,
        makeCtx(memberOntology, memberRec2.handleTrusted),
        actionType,
      ),
    );

    expect(memberRun2.ok).toBe(true);
    expect(memberRec2.fullMetadataPaths().filter((path) => path.includes(ENGAGEMENT))).toEqual([]);
  });

  it('has zero staleness across Publish version bumps that keep the same Function bundle on the same warm worker', async () => {
    const { ir, functions } = await withFunctions(
      [{ apiName: 'inspectMetadata', inputs: [{ name: 'label', type: 'string' }], edits: [ENGAGEMENT] }],
      SOURCE,
    );

    const v1 = compiledWithMetadata(ir, functions, 1);
    const accountV1Meta = v1.metadata.objectTypes[ACCOUNT];

    if (!accountV1Meta) throw new Error('Missing Account metadata.');

    const v2: CompiledOntology = {
      ...v1,
      version: 2,
      metadata: {
        ...v1.metadata,
        objectTypes: {
          ...v1.metadata.objectTypes,
          [ACCOUNT]: {
            ...accountV1Meta,
            objectType: { ...accountV1Meta.objectType, displayName: 'Customer Account v2' },
          },
        },
      },
    };

    const { actionType, fn } = functionOf(v1, 'inspectMetadata');
    const snapshot = trustedSnapshot(emptyDb);

    const rawTitle = (
      edits: readonly { readonly type: string; readonly properties?: ReadonlyMap<string, unknown> }[],
    ): string => {
      const value = edits[0]?.type === 'addObject' ? edits[0].properties?.get('title') : '';

      return typeof value === 'string' ? value : '';
    };

    const rec1 = recordingTrusted({});

    const r1 = await settle(
      runFunction(fn, new Map([['label', 'v1-run']]), snapshot, makeCtx(v1, rec1.handleTrusted), actionType),
    );

    expect(r1.ok).toBe(true);

    if (!r1.ok) return;

    const f1 = JSON.parse(rawTitle(r1.value)) as {
      thread: number;
      account: { displayName: string };
    };

    expect(f1.account.displayName).toBe(accountV1Meta.objectType.displayName);

    const rec2 = recordingTrusted({});

    const r2 = await settle(
      runFunction(fn, new Map([['label', 'v2-run']]), snapshot, makeCtx(v2, rec2.handleTrusted), actionType),
    );

    expect(r2.ok).toBe(true);

    if (!r2.ok) return;

    const f2 = JSON.parse(rawTitle(r2.value)) as {
      thread: number;
      account: { displayName: string };
    };

    expect(f2.thread).toBe(f1.thread);
    expect(f2.account.displayName).toBe('Customer Account v2');
    expect(rec2.fullMetadataPaths()).toHaveLength(2);

    const rec3 = recordingTrusted({});

    const r3 = await settle(
      runFunction(fn, new Map([['label', 'v2-run-2']]), snapshot, makeCtx(v2, rec3.handleTrusted), actionType),
    );

    expect(r3.ok).toBe(true);
    expect(rec3.fullMetadataPaths()).toEqual([]);
  });

  it('never leaks cached metadata or objects across different installations (organizations) sharing the same bundle', async () => {
    const { ir, functions } = await withFunctions(
      [{ apiName: 'readBoth', inputs: [{ name: 'label', type: 'string' }], edits: [ACCOUNT] }],
      SOURCE,
    );

    const orgAOntology = compiledWithMetadata(ir, functions, 1);
    const otherRid = 'ri.ontology.main.ontology.00000000-0000-4000-8000-000000001154';

    const orgBOntology: CompiledOntology = {
      ...orgAOntology,
      metadata: {
        ...orgAOntology.metadata,
        ontology: { ...orgAOntology.metadata.ontology, rid: otherRid },
      },
    };

    expect(clientKeyOf(orgBOntology)).not.toBe(clientKeyOf(orgAOntology));

    const { actionType, fn } = functionOf(orgAOntology, 'readBoth');
    const snapshot = trustedSnapshot(emptyDb);

    const rawName = (
      edits: readonly { readonly type: string; readonly properties?: ReadonlyMap<string, unknown> }[],
    ): string => {
      const value = edits[0]?.type === 'addObject' ? edits[0].properties?.get('name') : '';

      return typeof value === 'string' ? value : '';
    };

    const recA = recordingTrusted({
      [ACCOUNT]: { __apiName: ACCOUNT, __primaryKey: 'acc-1', accountId: 'acc-1', name: 'Org A Secret' },
      [ENGAGEMENT]: { __apiName: ENGAGEMENT, __primaryKey: 'eng-1', engagementId: 'eng-1', title: 'Org A Deal' },
    });

    const runA = await settle(
      runFunction(
        fn,
        new Map([['label', 'org-a']]),
        snapshot,
        makeCtx(orgAOntology, recA.handleTrusted, 'org_a'),
        actionType,
      ),
    );

    expect(runA.ok).toBe(true);

    if (!runA.ok) return;

    const payloadA = JSON.parse(rawName(runA.value)) as {
      thread: number;
      accountName: string;
    };

    const recB = recordingTrusted({
      [ACCOUNT]: { __apiName: ACCOUNT, __primaryKey: 'acc-1', accountId: 'acc-1', name: 'Org B Secret' },
      [ENGAGEMENT]: { __apiName: ENGAGEMENT, __primaryKey: 'eng-1', engagementId: 'eng-1', title: 'Org B Deal' },
    });

    const runB = await settle(
      runFunction(
        fn,
        new Map([['label', 'org-b']]),
        snapshot,
        makeCtx(orgBOntology, recB.handleTrusted, 'org_b'),
        actionType,
      ),
    );

    expect(runB.ok).toBe(true);

    if (!runB.ok) return;

    const payloadB = JSON.parse(rawName(runB.value)) as {
      thread: number;
      accountName: string;
    };

    expect(payloadB.thread).not.toBe(payloadA.thread);
    expect(payloadA.accountName).toBe('Org A Secret');
    expect(payloadB.accountName).toBe('Org B Secret');
    expect(recB.fullMetadataPaths()).toHaveLength(2);
    expect(recB.fullMetadataPaths().every((path) => path.includes(otherRid))).toBe(true);
  });

  it('bounds the per-worker client cache via LRU eviction so distinct keys never grow without bound', async () => {
    const bundle = `
      let created = 0;
      export const createClient = () => ({ id: ++created });
      export const functions = {
        id: async (client) => client.id,
      };
    `;

    const rid = 'ri.ontology.main.ontology.lru-test';
    const bridge = () => Promise.resolve({ status: 200, headers: [] as [string, string][], body: '' });

    const runKey = async (clientKey: string) => {
      const ran = await settle(
        callFunction({ bundle, function: 'id', inputs: [], ontologyRid: rid, clientKey }, bridge),
      );

      if (!ran.ok) throw ran.error;

      return ran.value as number;
    };

    const key0Id = await runKey('key-0');

    const key1Id = await runKey('key-1');

    expect(await runKey('key-0')).toBe(key0Id);

    for (let i = 2; i <= 16; i += 1) {
      await runKey(`key-${i}`);
    }

    expect(await runKey('key-0')).toBe(key0Id);

    expect(await runKey('key-1')).toBeGreaterThan(key1Id);
  });

  it('handles null-body bridge responses in run.ts without failing', async () => {
    const { ir, functions } = await withFunctions(
      [{ apiName: 'inspectMetadata', inputs: [{ name: 'label', type: 'string' }], edits: [ENGAGEMENT] }],
      SOURCE,
    );

    const ontology = compiledWithMetadata(ir, functions, 9);
    const { actionType, fn } = functionOf(ontology, 'inspectMetadata');
    const nullBodyTrusted: HandleTrusted = () => Promise.resolve(new Response(null, { status: 404 }));

    const ran = await settle(
      runFunction(
        fn,
        new Map([['label', 'null-body']]),
        trustedSnapshot(emptyDb),
        makeCtx(ontology, nullBodyTrusted),
        actionType,
      ),
    );

    expect(ran.ok).toBe(true);

    if (!ran.ok) return;

    expect(ran.value).toHaveLength(1);
    expect(ran.value[0]?.type).toBe('addObject');
  });
});
