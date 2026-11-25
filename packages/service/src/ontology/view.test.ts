import { describe, expect, it } from 'vitest';
import type { OrganizationCaller } from '../handler/index.ts';
import type { Db as PromiseDb } from '../db/promise.test-utils.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';
import type { Db, Sql } from '../db/index.ts';
import { ApiError, settle } from '../errors/index.ts';
import { convert } from '../metadata.test-utils.ts';
import { ORGANIZATION, OTHER_ORGANIZATION } from '../tokens.test-utils.ts';
import { UserId } from '../auth/caller.ts';
import { NS, stored, twinFunctions, twinGrantsFile, twinIr, unchecked } from './stored.test-utils.ts';
import { getPermissionCatalog, openOntology, type CompileRun } from './view.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;

const ALL_PERMISSIONS = [
  'accounts:read',
  'accounts:write',
  'accounts:close',
  'engagements:read',
  'engagements:write',
  'probes:read',
  'probes:write',
] as const;

const ir = twinIr('0.7.0');
const functions = twinFunctions('0.7.0');
const grants = twinGrantsFile();
const converted = convert(ir, { functions, version: 1 });
const osdkSet = stored(ir).osdkSet;

interface FakeState {
  version: number;
  database: string;
  product: string;
  installations: Map<string, { rid: string; organization: string; version?: number; apiName?: string }>;
  storedVersions: Set<number>;
  failRegistry?: Error | undefined;
  failProductVersion?: Error | undefined;
}

interface ControlledDb {
  readonly db: Db;
  readonly counts: { registry: number; productVersion: number };
  readonly state: FakeState;
  gateRegistry: () => { entered: Promise<undefined>; release: () => void };
  gateProductVersion: () => { entered: Promise<undefined>; release: () => void };
  waitForRegistryCalls: (target: number) => Promise<undefined>;
}

let dbSeq = 0;

function createControlledDb(overrides: Partial<FakeState> = {}): ControlledDb {
  dbSeq += 1;

  const rid = `ri.ontology.main.ontology.view-test-${dbSeq}`;

  const state: FakeState = {
    version: 1,
    database: `view_test_db_${dbSeq}`,
    product: `view_test_product_${dbSeq}`,
    installations: new Map([[rid, { rid, organization: ORGANIZATION }]]),
    storedVersions: new Set([1, 2]),
    ...overrides,
  };

  const counts = { registry: 0, productVersion: 0 };
  let registryGate: { entered: PromiseWithResolvers<undefined>; release: PromiseWithResolvers<undefined> } | undefined;
  let productGate: { entered: PromiseWithResolvers<undefined>; release: PromiseWithResolvers<undefined> } | undefined;
  const registryWaiters: { target: number; done: PromiseWithResolvers<undefined> }[] = [];

  const notifyRegistry = () => {
    for (let i = registryWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = registryWaiters[i];

      if (waiter && counts.registry >= waiter.target) {
        registryWaiters.splice(i, 1);

        waiter.done.resolve(undefined);
      }
    }
  };

  const promiseDb: PromiseDb = {
    query: async <Row extends object>(statement: Sql): Promise<Row[]> => {
      if (statement.text.includes('ontology_registry.ontologies')) {
        counts.registry += 1;

        notifyRegistry();

        const gate = registryGate;

        if (gate) {
          gate.entered.resolve(undefined);

          await gate.release.promise;
        }

        if (state.failRegistry) throw state.failRegistry;

        const [queryRid, queryOrg] = statement.values as [string, string];
        const found = state.installations.get(queryRid);

        if (!found || found.organization !== queryOrg) return [];

        const row = {
          rid: found.rid,
          api_name: found.apiName ?? 'twin',
          display_name: 'Twin',
          object_schema: 'ontology_1_objects',
          engine_schema: 'ontology_1_engine',
          product: state.product,
          version: found.version ?? state.version,
          database: state.database,
        };

        return [unchecked<Row>(row)];
      }

      if (statement.text.includes('ontology_registry.product_versions')) {
        counts.productVersion += 1;

        const gate = productGate;

        if (gate) {
          gate.entered.resolve(undefined);

          await gate.release.promise;
        }

        if (state.failProductVersion) throw state.failProductVersion;

        const [, version] = statement.values as [string, number];

        if (!state.storedVersions.has(version)) return [];

        const row = {
          ir,
          metadata: converted.metadata,
          osdk_set: osdkSet,
          functions,
          grants,
        };

        return [unchecked<Row>(row)];
      }

      throw new Error(`Unexpected SQL in view.test.ts: ${statement.text}`);
    },
    stream: () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('No stream in view.test.ts')) }),
    }),
    transaction: () => Promise.reject(new Error('No transaction in view.test.ts')),
    snapshot: () => Promise.reject(new Error('No snapshot in view.test.ts')),
  };

  return {
    db: fallibleOf(promiseDb),
    counts,
    state,
    gateRegistry() {
      const gate = { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() };

      registryGate = gate;

      return {
        entered: gate.entered.promise,
        release: () => {
          if (registryGate === gate) registryGate = undefined;

          gate.release.resolve(undefined);
        },
      };
    },
    gateProductVersion() {
      const gate = { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() };

      productGate = gate;

      return {
        entered: gate.entered.promise,
        release: () => {
          if (productGate === gate) productGate = undefined;

          gate.release.resolve(undefined);
        },
      };
    },
    waitForRegistryCalls(target: number) {
      if (counts.registry >= target) return Promise.resolve(undefined);

      const done = Promise.withResolvers<undefined>();

      registryWaiters.push({ target, done });

      return done.promise;
    },
  };
}

const flushMicrotasks = () => new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined)));

function callerOf(permissions: readonly string[], organization = ORGANIZATION): OrganizationCaller {
  return { user: UserId.parse('user-1'), kind: 'person', organization, permissions };
}

describe('single-flight coalescing on ontology_registry.ontologies', () => {
  it('coalesces concurrent openOntology registry lookups for the same db, rid, and organization while keeping each caller permission cut distinct', async () => {
    const controlled = createControlledDb();
    const [rid] = controlled.state.installations.keys();

    if (!rid) throw new Error('Expected test rid.');

    const gate = controlled.gateRegistry();

    const adminCaller = callerOf(ALL_PERMISSIONS);
    const engagementOnlyCaller = callerOf(['engagements:read']);

    const first = settle(openOntology(controlled.db, rid, adminCaller));

    await gate.entered;

    const second = settle(openOntology(controlled.db, rid, engagementOnlyCaller));
    const third = settle(openOntology(controlled.db, rid, adminCaller));

    gate.release();

    const [r1, r2, r3] = await Promise.all([first, second, third]);

    expect(controlled.counts.registry).toBe(1);
    expect(r1.ok && r2.ok && r3.ok).toBe(true);

    if (!r1.ok || !r2.ok || !r3.ok) return;

    expect(r1.value.ontology.objectTypes.has(ACCOUNT)).toBe(true);
    expect(r1.value.ontology.objectTypes.has(ENGAGEMENT)).toBe(true);
    expect(r2.value.ontology.objectTypes.has(ACCOUNT)).toBe(false);
    expect(r2.value.ontology.objectTypes.has(ENGAGEMENT)).toBe(true);
    expect(r3.value.ontology.objectTypes.has(ACCOUNT)).toBe(true);
  });

  it('has strict zero TTL: a request starting after the previous lookup settled queries Postgres again and observes a Publish version bump immediately', async () => {
    const controlled = createControlledDb();
    const [rid] = controlled.state.installations.keys();

    if (!rid) throw new Error('Expected test rid.');

    const caller = callerOf(ALL_PERMISSIONS);

    const v1 = await settle(openOntology(controlled.db, rid, caller));

    expect(v1.ok).toBe(true);

    if (!v1.ok) return;

    expect(v1.value.ontology.version).toBe(1);
    expect(controlled.counts.registry).toBe(1);

    controlled.state.version = 2;

    const v2 = await settle(openOntology(controlled.db, rid, caller));

    expect(v2.ok).toBe(true);

    if (!v2.ok) return;

    expect(v2.value.ontology.version).toBe(2);
    expect(controlled.counts.registry).toBe(2);
  });

  it('isolates in-flight registry lookups across distinct Db instances', async () => {
    const rid = 'ri.ontology.main.ontology.shared-rid';

    const firstDb = createControlledDb({
      version: 1,
      installations: new Map([[rid, { rid, organization: ORGANIZATION }]]),
    });

    const secondDb = createControlledDb({
      version: 2,
      installations: new Map([[rid, { rid, organization: ORGANIZATION }]]),
    });

    const gate = firstDb.gateRegistry();
    const caller = callerOf(ALL_PERMISSIONS);

    const p1 = settle(openOntology(firstDb.db, rid, caller));

    await gate.entered;

    const p2 = settle(openOntology(secondDb.db, rid, caller));

    const r2 = await p2;

    expect(r2.ok).toBe(true);
    expect(r2.ok ? r2.value.ontology.version : undefined).toBe(2);
    expect(secondDb.counts.registry).toBe(1);

    gate.release();

    const r1 = await p1;

    expect(r1.ok).toBe(true);
    expect(r1.ok ? r1.value.ontology.version : undefined).toBe(1);
    expect(firstDb.counts.registry).toBe(1);
  });

  it('does not coalesce across different organizations or different RIDs on the same Db', async () => {
    const ridA = 'ri.ontology.main.ontology.rid-a';
    const ridB = 'ri.ontology.main.ontology.rid-b';

    const controlled = createControlledDb({
      installations: new Map([
        [ridA, { rid: ridA, organization: ORGANIZATION, apiName: 'alpha' }],
        [ridB, { rid: ridB, organization: ORGANIZATION, apiName: 'beta' }],
      ]),
    });

    const gate = controlled.gateRegistry();

    const pA = settle(openOntology(controlled.db, ridA, callerOf(ALL_PERMISSIONS, ORGANIZATION)));

    await gate.entered;

    const pOtherOrg = settle(openOntology(controlled.db, ridA, callerOf(ALL_PERMISSIONS, OTHER_ORGANIZATION)));
    const pB = settle(openOntology(controlled.db, ridB, callerOf(ALL_PERMISSIONS, ORGANIZATION)));

    gate.release();

    const [rA, rOtherOrg, rB] = await Promise.all([pA, pOtherOrg, pB]);

    expect(controlled.counts.registry).toBe(3);
    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);
    expect(rOtherOrg.ok).toBe(false);
    expect(rOtherOrg.ok ? undefined : rOtherOrg.error).toBeInstanceOf(ApiError);
    expect(rA.ok ? rA.value.ontology.metadata.ontology.apiName : undefined).toBe('alpha');
    expect(rB.ok ? rB.value.ontology.metadata.ontology.apiName : undefined).toBe('beta');
  });

  it('clears the in-flight entry after a failure so the next call retries immediately', async () => {
    const controlled = createControlledDb({ failRegistry: new Error('transient db outage') });
    const [rid] = controlled.state.installations.keys();

    if (!rid) throw new Error('Expected test rid.');

    const caller = callerOf(ALL_PERMISSIONS);
    const gate = controlled.gateRegistry();

    const p1 = settle(openOntology(controlled.db, rid, caller));

    await gate.entered;

    const p2 = settle(openOntology(controlled.db, rid, caller));

    gate.release();

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(controlled.counts.registry).toBe(1);

    controlled.state.failRegistry = undefined;

    const r3 = await settle(openOntology(controlled.db, rid, caller));

    expect(r3.ok).toBe(true);
    expect(controlled.counts.registry).toBe(2);
  });

  it('coalesces getPermissionCatalog with concurrent openOntology on the same installation', async () => {
    const controlled = createControlledDb();
    const [rid] = controlled.state.installations.keys();

    if (!rid) throw new Error('Expected test rid.');

    const caller = callerOf(ALL_PERMISSIONS);
    const gate = controlled.gateRegistry();

    const pOpen = settle(openOntology(controlled.db, rid, caller));

    await gate.entered;

    const pCat = settle(
      getPermissionCatalog(
        {
          params: { ontologyRid: rid },
          query: new URLSearchParams(),
          body: undefined,
          signal: new AbortController().signal,
        },
        { db: controlled.db, caller, log: () => undefined },
      ),
    );

    gate.release();

    const [rOpen, rCat] = await Promise.all([pOpen, pCat]);

    expect(rOpen.ok && rCat.ok).toBe(true);
    expect(controlled.counts.registry).toBe(1);
    expect(controlled.counts.productVersion).toBe(1);
  });
});

describe('single-flight coalescing on compiledVersions cache miss', () => {
  it('compiles a new product version only once when concurrent requests arrive across two installations of the same product', async () => {
    const rid1 = 'ri.ontology.main.ontology.pv-1';
    const rid2 = 'ri.ontology.main.ontology.pv-2';

    const controlled = createControlledDb({
      installations: new Map([
        [rid1, { rid: rid1, organization: ORGANIZATION }],
        [rid2, { rid: rid2, organization: ORGANIZATION }],
      ]),
    });

    const caller = callerOf(ALL_PERMISSIONS);
    let compileCalls = 0;

    const compile: CompileRun = (_version, run) => {
      compileCalls += 1;

      return run();
    };

    const gate = controlled.gateProductVersion();
    const p1 = settle(openOntology(controlled.db, rid1, caller, compile));

    await gate.entered;

    const p2 = settle(openOntology(controlled.db, rid2, caller, compile));
    const p3 = settle(openOntology(controlled.db, rid1, caller, compile));

    await controlled.waitForRegistryCalls(3);

    await flushMicrotasks();

    gate.release();

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    expect(controlled.counts.productVersion).toBe(1);
    expect(compileCalls).toBe(1);
  });

  it('clears the in-flight product version compile on failure so a subsequent request retries and caches the compiled version', async () => {
    const controlled = createControlledDb({ failProductVersion: new Error('transient product_versions error') });
    const [rid] = controlled.state.installations.keys();

    if (!rid) throw new Error('Expected test rid.');

    const caller = callerOf(ALL_PERMISSIONS);
    const gate = controlled.gateProductVersion();

    const p1 = settle(openOntology(controlled.db, rid, caller));

    await gate.entered;

    const p2 = settle(openOntology(controlled.db, rid, caller));

    await controlled.waitForRegistryCalls(2);

    await flushMicrotasks();

    gate.release();

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(controlled.counts.productVersion).toBe(1);

    controlled.state.failProductVersion = undefined;

    const r3 = await settle(openOntology(controlled.db, rid, caller));

    expect(r3.ok).toBe(true);
    expect(controlled.counts.productVersion).toBe(2);

    const r4 = await settle(openOntology(controlled.db, rid, caller));

    expect(r4.ok).toBe(true);
    expect(controlled.counts.productVersion).toBe(2);
  });

  it('bounds compiledVersions to 32 entries with LRU eviction', async () => {
    const versions = Array.from({ length: 34 }, (_, index) => index + 1);
    const controlled = createControlledDb({ storedVersions: new Set(versions) });
    const [rid] = controlled.state.installations.keys();

    if (!rid) throw new Error('Expected test rid.');

    const caller = callerOf(ALL_PERMISSIONS);

    for (let version = 1; version <= 32; version += 1) {
      controlled.state.version = version;

      const loaded = await settle(openOntology(controlled.db, rid, caller));

      expect(loaded.ok).toBe(true);
    }

    expect(controlled.counts.productVersion).toBe(32);

    controlled.state.version = 1;

    await settle(openOntology(controlled.db, rid, caller));

    expect(controlled.counts.productVersion).toBe(32);

    controlled.state.version = 33;

    await settle(openOntology(controlled.db, rid, caller));

    expect(controlled.counts.productVersion).toBe(33);

    controlled.state.version = 1;

    await settle(openOntology(controlled.db, rid, caller));

    expect(controlled.counts.productVersion).toBe(33);

    controlled.state.version = 2;

    await settle(openOntology(controlled.db, rid, caller));

    expect(controlled.counts.productVersion).toBe(34);
  });
});
