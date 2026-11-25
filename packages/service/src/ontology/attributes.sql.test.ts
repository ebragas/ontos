import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserId } from '../auth/caller.ts';
import type { Sql } from '../db/index.ts';
import type { Db } from '../db/promise.test-utils.ts';
import type { GrantsFile } from './index.ts';
import { insertObjects, startActions, type ActionsService, type RawAnswer } from '../actions/actions.test-utils.ts';
import {
  ATTRIBUTE_DECLARATIONS,
  attributesIr,
  compileOrThrow,
  securityGroupsOf,
  stored,
  viewPolicyOf,
} from './stored.test-utils.ts';
import { actionOf } from '../functions/functions.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { checkOntologyVersions } from './index.ts';
import { resolvePersonAttributes } from './access/personAttributes.ts';
import { personValue } from '../db/index.ts';
import { openReader, fallibleOf, rejecting } from '../db/promise.test-utils.ts';
import {
  attributeGrants,
  CREW,
  CREW_MEMBER,
  JOBSITE,
  ONTOLOGY,
  PEOPLE,
  ROLES,
  SCHEMAS,
  seedAttributes,
  twin,
  type Person,
} from './attributes.test-utils.ts';

let service: ActionsService;
let grants: GrantsFile;

beforeAll(async () => {
  const { ir, functions } = await twin();

  grants = attributeGrants(ir);

  service = await startActions(ir, functions, grants);
});

afterAll(() => service?.stop());

beforeEach(() => seedAttributes(service));

function watched(db: Db, fail: false | 'throw' | 'no row' = false): { readonly db: Db; readonly reads: () => number } {
  let reads = 0;

  const wrapped: Db = {
    query: <Row extends object>(statement: Sql) => {
      if (!statement.text.startsWith('SELECT ARRAY(')) return db.query<Row>(statement);

      reads += 1;

      if (fail === 'throw') return Promise.reject(new Error('The test fails the Person attribute read.'));

      return fail === 'no row' ? Promise.resolve([]) : db.query<Row>(statement);
    },
    stream: <Row extends object>(statement: Sql) => db.stream<Row>(statement),
    snapshot: (run) => db.snapshot(run),
    transaction: (run) => db.transaction(run),
  };

  return { db: wrapped, reads: () => reads };
}

const base = (objectType: string) => ({ type: 'base', objectType });
const byKey = (field: string) => ({ orderBy: { fields: [{ field, direction: 'asc' }] }, excludeRid: true });

function post(path: string, body: unknown, person: Person, db?: Db): Promise<RawAnswer> {
  return service.call('POST', `${ONTOLOGY}/${path}`, body, { ...PEOPLE[person], ...(db ? { db } : {}) });
}

async function keysOf(objectType: string, primaryKey: string, person: Person, db?: Db): Promise<unknown> {
  const body = { objectSet: base(objectType), select: [primaryKey], ...byKey(primaryKey) };

  const answer = await service.call('POST', `${ONTOLOGY}/objectSets/loadObjects`, body, {
    ...PEOPLE[person],
    ...(db ? { db } : {}),
  });

  if (answer.status !== 200) return { status: answer.status, text: answer.text };

  return (JSON.parse(answer.text) as { data: Record<string, unknown>[] }).data.map((object) => object[primaryKey]);
}

const jobsites = (person: Person, db?: Db) => keysOf(JOBSITE, 'jobsiteId', person, db);
const members = (person: Person) => keysOf(CREW_MEMBER, 'memberId', person);

async function jobsiteIdsOf(user: string): Promise<unknown> {
  const attribute = resolvePersonAttributes(compileOrThrow(stored(attributesIr())), grants).get('jobsiteIds');

  if (!attribute) throw new Error('jobsiteIds did not resolve.');

  const { reader } = await openReader(service.db, SCHEMAS, [attribute], {
    user: UserId.parse(user),
    permissions: ROLES.foreman,
  });

  return personValue(reader, { kind: 'attribute', name: 'jobsiteIds' });
}

describe('the Jobsites of a foreman', () => {
  it('ontology/object-security-policies#person-attributes ontology/object-security-policies#conditions: a foreman sees only the Jobsites of their crews', async () => {
    expect(await jobsites('ann')).toEqual(['j-1', 'j-2']);
  });

  it('ontology/object-security-policies#person-attributes: the start Property equals the User ID exactly: no pattern, no case fold, and no prefix', async () => {
    const member = (memberId: string, userId: string, crewId: string) => ({ memberId, userId, crewId });

    await insertObjects(service.db, CREW_MEMBER, [
      member('m-upper', 'USER_ANN', 'crew-b'),
      member('m-x', 'userXann', 'crew-c'),
      member('m-ann2', 'user_ann2', 'crew-c'),
      member('m-percent', '%', 'crew-b'),
    ]);

    const subs = ['user_ann', 'USER_ANN', 'user_', 'user_an', '%', '_', 'user_ann '];
    const read: Record<string, unknown> = {};

    for (const sub of subs) read[sub] = await jobsiteIdsOf(sub);

    expect(read).toEqual({
      user_ann: ['j-1', 'j-2'],
      USER_ANN: ['j-2', 'j-3'],
      user_: [],
      user_an: [],
      '%': ['j-2', 'j-3'],
      _: [],
      'user_ann ': [],
    });

    expect(await jobsites('ann')).toEqual(['j-1', 'j-2']);
  });

  it('ontology/object-security-policies#person-attributes: an attribute holds only the keys of Objects that exist, so a join row to no Jobsite adds no key', async () => {
    await service.db.query(
      sql("INSERT INTO ontology_1_objects.crew_jobsites (a_crew_id, b_jobsite_id) VALUES ('crew-a', 'j-ghost')"),
    );

    expect(await jobsiteIdsOf('user_ann')).toEqual(['j-1', 'j-2']);

    expect(await jobsites('ann')).toEqual(['j-1', 'j-2']);
  });

  it('ontology/object-security-policies#person-attributes: the service reads the path, not the permissions: a role with no permission of the Object Types of the path reads the same attribute', async () => {
    expect(await jobsites('site')).toEqual(['j-1', 'j-2']);

    expect(await keysOf(CREW, 'crewId', 'site')).toMatchObject({ status: 404 });
  });

  it('ontology/object-security-policies#person-attributes: a person with 2 start Objects gets the union of their paths', async () => {
    expect(await jobsites('ben')).toEqual(['j-2', 'j-3']);
  });

  it('ontology/object-security-policies#person-attributes: a person with no start Object, and a path with no end Object, get the empty set, so the comparison fails', async () => {
    expect({ carl: await jobsites('carl'), dan: await jobsites('dan') }).toEqual({ carl: [], dan: [] });
  });

  it('ontology/object-security-policies#person-attributes service/authentication#people: a User ID that holds U+0000 has no start Object, so it reads the empty set, and a route gives it 401, not 500', async () => {
    expect(await jobsiteIdsOf('user_ann\u0000')).toEqual([]);

    const answer = await service.call(
      'POST',
      `${ONTOLOGY}/objectSets/loadObjects`,
      { objectSet: base(JOBSITE), select: ['jobsiteId'] },
      { claims: { sub: 'user_ann\u0000' } },
    );

    expect([answer.status, JSON.parse(answer.text)]).toMatchObject([
      401,
      { errorCode: 'UNAUTHORIZED', errorName: 'Default:Unauthorized' },
    ]);
  });

  it('ontology/object-security-policies#person-attributes: a Person attribute with no Link side collects the primary keys of the start Objects', async () => {
    expect({ ann: await members('ann'), ben: await members('ben'), carl: await members('carl') }).toEqual({
      ann: ['m-ann'],
      ben: ['m-ben-1', 'm-ben-2'],
      carl: [],
    });
  });

  it('ontology/object-security-policies#person-attributes: a Person attribute reads the stored Objects and Links, not the view of the person', async () => {
    expect(await members('admin')).toEqual([]);

    expect(await members('dan')).toEqual(['m-dan']);

    expect(await jobsites('ben')).toEqual(['j-2', 'j-3']);
  });

  it('ontology/object-security-policies#conditions: in an or, the admin branch passes for an admin whose Person attribute is empty', async () => {
    expect(await jobsites('admin')).toEqual(['j-1', 'j-2', 'j-3', 'j-4', 'j-5']);
  });
});

describe('when the Ontology service reads a Person attribute', () => {
  it('ontology/object-security-policies#person-attributes: it reads each attribute once for each request, so a change holds at the next request', async () => {
    const { db, reads } = watched(service.db);

    expect(await jobsites('ann', db)).toEqual(['j-1', 'j-2']);

    expect(reads()).toBe(1);

    await insertObjects(service.db, CREW_MEMBER, [{ memberId: 'm-ann-2', userId: 'user_ann', crewId: 'crew-c' }]);

    expect(await jobsites('ann', db)).toEqual(['j-1', 'j-2', 'j-4']);

    expect(reads()).toBe(2);

    await service.db.query(sql("DELETE FROM ontology_1_objects.crew_jobsites WHERE a_crew_id = 'crew-a'"));

    expect(await jobsites('ann', db)).toEqual(['j-4']);
  });

  it('ontology/object-security-policies#person-attributes: a request whose view reads no Person attribute reads none', async () => {
    const { db, reads } = watched(service.db);

    expect(await keysOf(CREW, 'crewId', 'office', db)).toEqual(['crew-a', 'crew-b', 'crew-c', 'crew-d']);

    expect(await keysOf(CREW, 'crewId', 'ann', db)).toEqual(['crew-a', 'crew-b', 'crew-c', 'crew-d']);

    expect(reads()).toBe(1);
  });

  it('ontology/object-security-policies#person-attributes: a failed read fails the request with 500 Default:Internal, and the request serves no data', async () => {
    const { db, reads } = watched(service.db, 'throw');

    const answer = await post(
      'objectSets/loadObjects',
      { objectSet: base(CREW), select: ['crewId'], ...byKey('crewId') },
      'ann',
      db,
    );

    expect(reads()).toBe(1);
    expect(answer.status).toBe(500);
    expect(JSON.parse(answer.text)).toMatchObject({ errorCode: 'INTERNAL', errorName: 'Default:Internal' });
    expect(answer.text).not.toContain('crew-');

    const over = await service.tool(
      'load_objects',
      { objectSet: base(JOBSITE), select: ['jobsiteId'] },
      { ...PEOPLE.ann, db },
    );

    expect(JSON.stringify(over.body)).not.toContain('j-');

    const empty = watched(service.db, 'no row');

    const noRow = await post(
      'objectSets/loadObjects',
      { objectSet: base(JOBSITE), select: ['jobsiteId'] },
      'admin',
      empty.db,
    );

    expect([empty.reads(), noRow.status, (JSON.parse(noRow.text) as { errorName: string }).errorName]).toEqual([
      1,
      500,
      'Default:Internal',
    ]);

    expect(noRow.text).not.toContain('j-');
  });
});

describe('each request path of a person reads with the attributes of that person', () => {
  async function overMcp(person: Person): Promise<unknown> {
    const answer = await service.tool(
      'load_objects',
      {
        objectSet: base(JOBSITE),
        select: ['jobsiteId'],
        orderBy: { fields: [{ field: 'jobsiteId', direction: 'asc' }] },
      },
      PEOPLE[person],
    );

    const result = (answer.body as { result: { structuredContent: { data: Record<string, unknown>[] } } }).result;

    return result.structuredContent.data.map((object) => object['jobsiteId']);
  }

  it('ontology/object-security-policies#person-attributes: load_objects of the Ontology MCP reads with the Person attributes of the person of the token', async () => {
    expect({ ann: await overMcp('ann'), ben: await overMcp('ben'), carl: await overMcp('carl') }).toEqual({
      ann: ['j-1', 'j-2'],
      ben: ['j-2', 'j-3'],
      carl: [],
    });
  });

  async function readByFunction(person: Person, db?: Db): Promise<unknown> {
    const applied = await service.apply(
      actionOf('readJobsites'),
      { parameters: { note: person }, options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' } },
      { ...PEOPLE[person], ...(db ? { db } : {}) },
    );

    expect(applied.status).toBe(200);

    const [row] = await service.db.query<{ name: string }>(
      sql("SELECT name FROM ontology_1_objects.crew WHERE crew_id = 'crew-d'"),
    );

    return JSON.parse(row?.name ?? 'null');
  }

  it('ontology/functions/functions#reads ontology/object-security-policies#person-attributes: the client of a Function reads with the Person attributes that its Action read, and the Action reads them once', async () => {
    const { db, reads } = watched(service.db);

    expect(await readByFunction('ann', db)).toEqual({ note: 'ann', jobsites: ['j-1', 'j-2'] });

    expect(reads()).toBe(1);

    expect(await readByFunction('ben')).toEqual({ note: 'ben', jobsites: ['j-2', 'j-3'] });

    expect(await readByFunction('carl')).toEqual({ note: 'carl', jobsites: [] });
  });

  it('2 people of 1 role share the cached view, and 200 concurrent requests give 0 crossed answers', async () => {
    const expected = { ann: ['j-1', 'j-2'], ben: ['j-2', 'j-3'] } as const;
    const people = Array.from({ length: 200 }, (_, index) => (index % 2 === 0 ? 'ann' : 'ben') as 'ann' | 'ben');

    const answers = await Promise.all(people.map(async (person) => ({ person, keys: await jobsites(person) })));

    expect(answers.filter(({ person, keys }) => JSON.stringify(keys) !== JSON.stringify(expected[person]))).toEqual([]);
    expect(answers).toHaveLength(200);
  });
});

describe('a publish of personAttributes', () => {
  const versions = async () =>
    (
      await service.db.query<{ version: number }>(
        sql("SELECT version FROM ontology_registry.product_versions WHERE product = 'twin' ORDER BY version"),
      )
    ).map((row) => row.version);

  it.each([
    [
      'an undeclared Person attribute',
      { memberIds: ATTRIBUTE_DECLARATIONS.memberIds },
      `The object security policy of the Object Type ${JOBSITE} reads the Person attribute jobsiteIds, which personAttributes does not declare.`,
    ],
    [
      'a missing Link side',
      {
        ...ATTRIBUTE_DECLARATIONS,
        jobsiteIds: { start: ATTRIBUTE_DECLARATIONS.jobsiteIds.start, links: ['crew', 'sites'] },
      },
      `The Person attribute jobsiteIds follows the Link side sites, which is not a side of the Object Type ${CREW}.`,
    ],
    [
      'a missing start Property',
      { ...ATTRIBUTE_DECLARATIONS, memberIds: { start: { objectType: CREW_MEMBER, property: 'email' }, links: [] } },
      `The Person attribute memberIds starts at the Property email, which the Object Type ${CREW_MEMBER} does not have.`,
    ],
    ['a policy that reads toString', { ...ATTRIBUTE_DECLARATIONS, toString: undefined }, undefined],
  ])(
    'the publish route refuses %s with 400 part grants, and stores no version',
    async (_name, personAttributes, problem) => {
      const { ir, functions } = await twin();

      const before = await versions();

      if (problem === undefined) {
        const [group] = securityGroupsOf(ir.ontology.objectTypes[JOBSITE]);

        if (!group) throw new Error('The twin Jobsite has no policy group.');

        viewPolicyOf(group).granularPolicyCondition = {
          type: 'comparison',
          comparison: {
            left: { type: 'property', property: 'jobsiteId' },
            operator: 'SUBSET_OF',
            right: {
              type: 'userProperty',
              userProperty: { type: 'userAttributes', userAttributes: { attributeKey: 'toString' } },
            },
          },
        };
      }

      const file = {
        ...grants,
        personAttributes: JSON.parse(JSON.stringify(personAttributes)) as NonNullable<GrantsFile['personAttributes']>,
      };

      const expected =
        problem ??
        `The object security policy of the Object Type ${JOBSITE} reads the Person attribute toString, which personAttributes does not declare.`;

      const refused = await service.publish(ir, functions, file).then(
        () => 'stored',
        (error: Error) => error.message,
      );

      const prefix = 'The publish gave 400: ';

      expect(refused.startsWith(prefix)).toBe(true);

      expect((JSON.parse(refused.slice(prefix.length)) as { parameters: unknown }).parameters).toEqual({
        part: 'grants',
        problems: [expected],
      });

      expect(await versions()).toEqual(before);
    },
  );

  it('service/publish#security-policies: a publish that changes only personAttributes makes a new version, and the new path holds at the next request', async () => {
    const { ir, functions } = await twin();

    const before = await versions();

    await service.publish(ir, functions, grants);

    expect(await versions()).toEqual(before);

    await service.publish(ir, functions, {
      ...grants,
      personAttributes: {
        ...ATTRIBUTE_DECLARATIONS,
        jobsiteIds: { start: ATTRIBUTE_DECLARATIONS.jobsiteIds.start, links: ['crew'] },
      },
    });

    const after = await versions();

    expect(after).toEqual([...before, Math.max(...before) + 1]);

    expect(await jobsites('ann')).toEqual([]);

    await service.publish(ir, functions, grants);

    expect(await jobsites('ann')).toEqual(['j-1', 'j-2']);
  });

  it.each([
    ['a String', '"jobsiteIds"'],
    [
      'an object whose declarations hold a 3rd key',
      JSON.stringify({
        jobsiteIds: { ...ATTRIBUTE_DECLARATIONS.jobsiteIds, via: [] },
        memberIds: { ...ATTRIBUTE_DECLARATIONS.memberIds, via: [] },
      }),
    ],
    [
      'an object whose declarations have no links',
      JSON.stringify({
        jobsiteIds: { start: ATTRIBUTE_DECLARATIONS.jobsiteIds.start },
        memberIds: { start: ATTRIBUTE_DECLARATIONS.memberIds.start },
      }),
    ],
  ])(
    'service/authentication#access: a stored personAttributes of %s makes the grants file not parse, so each caller sees no type, and the cold start passes',
    async (_shape, value) => {
      const { ir, functions } = await twin();

      await service.publish(ir, functions, {
        ...grants,
        personAttributes: { ...ATTRIBUTE_DECLARATIONS, [`spare${value.length}`]: ATTRIBUTE_DECLARATIONS.memberIds },
      });

      await service.db.query({
        text: `UPDATE ontology_registry.product_versions SET grants = jsonb_set(grants, '{personAttributes}', $1::jsonb) WHERE product = 'twin' AND version = (SELECT max(version) FROM ontology_registry.product_versions WHERE product = 'twin')`,
        values: [value],
      });

      const statuses = async (person: Person) => ({
        jobsites: ((await jobsites(person)) as { status?: number }).status,
        members: ((await members(person)) as { status?: number }).status,
      });

      expect({ ann: await statuses('ann'), admin: await statuses('admin') }).toEqual({
        ann: { jobsites: 404, members: 404 },
        admin: { jobsites: 404, members: 404 },
      });

      await expect(rejecting(checkOntologyVersions(fallibleOf(service.db)))).resolves.toBeUndefined();

      await service.publish(ir, functions, grants);

      expect(await jobsites('ann')).toEqual(['j-1', 'j-2']);
    },
  );
});
