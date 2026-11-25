import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPool } from '../db/index.ts';
import { createDb, type Db, fallibleOf, rejecting } from '../db/promise.test-utils.ts';
import { ApiError } from '../errors/index.ts';
import type { Handle, HandleInput } from '../handler/index.ts';
import type { JsonObject } from '../ontology/index.ts';
import {
  irOf,
  NS,
  policiesIr,
  propertyPoliciesIr,
  securityGroupsOf,
  unchecked,
  viewPolicyOf,
} from '../ontology/stored.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { LISTED_SET, rejection, storeVersion } from './releasesSupport.test-utils.ts';
import { expectAllOnNewest, newDatabase, OSDK_SET, sql, type TestDatabase } from './publish.test-utils.ts';
import { MEMBER, noUsers, testSettings, TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import { createTestIssuer, type TestIssuer } from '../tokens.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';
import { groupGrants, PROPERTY_ROLES } from '../policiesPeople.test-utils.ts';

const ACCOUNT = `${NS}Account`;

function accountIr(condition?: unknown): OntologyIr {
  const block = policiesIr().ontology.objectTypes[ACCOUNT];

  if (!block) throw new Error('policies.json has no Account.');

  if (condition !== undefined) {
    const [group] = securityGroupsOf(block);

    if (!group) throw new Error('policies.json has no group on Account.');

    viewPolicyOf(group).granularPolicyCondition = unchecked(condition);
  }

  return irOf(block);
}

const NOT = {
  type: 'not',
  not: {
    condition: {
      type: 'comparison',
      comparison: {
        left: { type: 'property', property: 'ownerId' },
        operator: 'EQUAL',
        right: { type: 'userProperty', userProperty: { type: 'userId', userId: {} } },
      },
    },
  },
};

let postgres: TestPostgres;
let issuer: TestIssuer;
let database: TestDatabase;
let pooledDb: Db;
let endPooled: () => Promise<void>;
let consoleLog: MockInstance<typeof console.log>;
let consoleError: MockInstance<typeof console.error>;

beforeAll(async () => {
  await import('../handler/index.ts');

  await import('../ontology/index.ts');

  postgres = await startPostgres();

  issuer = await createTestIssuer(testSettings.auth);
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await newDatabase(postgres.url);

  const pool = createPool(database.url);

  pooledDb = createDb(pool);

  endPooled = () => pool.end();

  consoleLog = vi.spyOn(console, 'log');

  consoleError = vi.spyOn(console, 'error');
});

afterEach(async () => {
  try {
    await expectAllOnNewest(database.db);
  } finally {
    consoleLog.mockRestore();

    consoleError.mockRestore();

    await endPooled();

    await database.end();
  }
});

async function newInstance(): Promise<Handle> {
  vi.resetModules();

  return (await import('../handler/index.ts')).handle;
}

function input(): HandleInput {
  return {
    db: fallibleOf(pooledDb),
    directDb: fallibleOf(database.db),
    settings: testSettings,
    keys: issuer.keys,
    users: noUsers,
    workos: stubPublish(),
  };
}

async function publish(
  ir: OntologyIr,
  validateOnly = false,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const handle = await newInstance();

  const body = {
    ir,
    product: 'twin',
    schemaMigrations: { migrations: [] },
    osdkSet: OSDK_SET,
    grants: groupGrants(ir, PROPERTY_ROLES),
    validateOnly,
  };

  const response = await handle(
    new Request('http://localhost/api/ontology-service/v1/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${await issuer.github()}` },
      body: JSON.stringify(body),
    }),
    input(),
  );

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('the publish of an object security policy', () => {
  it.each([true, false])(
    'service/publish#security-policies: a policy that compile refuses gets 400 Default:InvalidArgument, and the error names the Object Type, the policy, and the feature (validateOnly %s)',
    async (validateOnly) => {
      const answer = await publish(accountIr(NOT), validateOnly);

      expect([answer.status, answer.body['errorName']]).toEqual([400, 'Default:InvalidArgument']);

      const text = JSON.stringify(answer.body['parameters']);

      for (const fragment of [ACCOUNT, "'own'", 'uses not']) expect(text).toContain(fragment);

      expect(await database.db.query(sql('SELECT version FROM ontology_registry.product_versions'))).toEqual([]);
    },
  );

  it('ontology/object-security-policies#conditions: a publish of the maker output of an and with the key condition gets 400, and stores no version', async () => {
    const typo = { type: 'and', condition: [NOT.not.condition] };

    const answer = await publish(accountIr(typo));

    expect([answer.status, answer.body['errorName']]).toEqual([400, 'Default:InvalidArgument']);

    expect(JSON.stringify(answer.body['parameters'])).toContain(
      `Object Type ${ACCOUNT} has the object security policy 'own', which has an and with no list of conditions.`,
    );

    expect(await database.db.query(sql('SELECT version FROM ontology_registry.product_versions'))).toEqual([]);
  });

  it('service/ontology-as-code#security-policies: publish stores the policy in the IR of the product version, and in no other column', async () => {
    const ir = accountIr();

    expect((await publish(ir)).status).toBe(200);

    const [row] = await database.db.query<{ ir: JsonObject }>(
      sql("SELECT ir FROM ontology_registry.product_versions WHERE product = 'twin' AND version = 1"),
    );

    expect(row?.ir['ontology']).toMatchObject({
      objectTypes: { [ACCOUNT]: { datasources: ir.ontology.objectTypes[ACCOUNT]?.datasources } },
    });

    const columns = await database.db.query<{ name: string }>(
      sql(
        "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'ontology_registry' AND table_name = 'product_versions'",
      ),
    );

    expect(columns.map(({ name }) => name).sort()).toEqual([
      'functions',
      'grants',
      'ir',
      'metadata',
      'osdk_set',
      'product',
      'published_at',
      'publisher',
      'schema_migrations',
      'version',
    ]);
  });
});

describe('the publish of a property security policy', () => {
  function propertyIr(twice: boolean): OntologyIr {
    const ir = propertyPoliciesIr();

    if (twice)
      securityGroupsOf(ir.ontology.objectTypes[ACCOUNT])
        .find((group) => group.rid === 'plain')
        ?.properties.push('rate');

    return ir;
  }

  it('service/publish#security-policies: publish accepts the property security policies that maker writes, and refuses a Property in 2 of them with 400 and no stored version', async () => {
    const refused = await publish(propertyIr(true));

    expect([refused.status, refused.body['errorName']]).toEqual([400, 'Default:InvalidArgument']);

    expect(JSON.stringify(refused.body['parameters'])).toContain(
      `Object Type ${ACCOUNT} has the Property rate in 2 property security policies, 'pay' and 'plain'.`,
    );

    expect(await database.db.query(sql('SELECT version FROM ontology_registry.product_versions'))).toEqual([]);

    expect((await publish(propertyIr(false))).status).toBe(200);
  });

  it.each([
    ['defaultObjectSecurityPolicy', 'object security policy'],
    ['pay', 'property security policy'],
  ])(
    'ontology/object-security-policies#conditions service/publish#security-policies: the IR form of a mandatoryOnly security with markings on the group %s gets 400, and stores no version',
    async (rid, kind) => {
      const ir = propertyPoliciesIr();
      const group = securityGroupsOf(ir.ontology.objectTypes[ACCOUNT]).find((each) => each.rid === rid);

      if (!group) throw new Error(`property-policies.json has no group ${rid}.`);

      group.security = {
        type: 'mandatoryOnly',
        mandatoryOnly: { policy: { markings: { m1: 'MANDATORY' }, assumedMarkings: [], assumedMarkingsV2: {} } },
      };

      const answer = await publish(ir);

      expect([answer.status, answer.body['errorName']]).toEqual([400, 'Default:InvalidArgument']);

      expect(JSON.stringify(answer.body['parameters'])).toContain(
        `Object Type ${ACCOUNT} has the ${kind} '${rid}', which reads markings. V1 has no markings.`,
      );

      expect(await database.db.query(sql('SELECT version FROM ontology_registry.product_versions'))).toEqual([]);
    },
  );
});

describe('the cold start of a stored version with a policy', () => {
  async function loadCurrent(): Promise<unknown> {
    vi.resetModules();

    const { openOntology } = await import('../ontology/index.ts');

    return (
      await rejecting(
        openOntology(fallibleOf(database.db), TEST_ONTOLOGY_RID, {
          ...MEMBER,
          permissions: [...PROPERTY_ROLES.member],
        }),
      )
    ).ontology.version;
  }

  it('service/ontology-as-code#security-policies: a stored version whose policy compile refuses fails the cold start with 503 OntologyVersionNotSupported', async () => {
    await storeVersion(database.db, 1, LISTED_SET, accountIr(NOT));

    const error = await rejection(loadCurrent());

    expect((error as object).constructor.name).toBe(ApiError.name);
    expect(error).toMatchObject({ status: 503, errorName: 'OntologyService:OntologyVersionNotSupported' });
  });

  it('service/ontology-as-code#security-policies: a stored version with a policy that compiles passes the cold start', async () => {
    await storeVersion(database.db, 1, LISTED_SET, accountIr());

    expect(await loadCurrent()).toBe(1);
  });
});
