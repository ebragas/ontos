import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../db/index.ts';
import type { Db } from '../db/promise.test-utils.ts';
import type { GrantsFile } from '../ontology/index.ts';
import { ATTRIBUTE_DECLARATIONS, attributesIr, ONTOLOGY_RID, unchecked, USE } from '../ontology/stored.test-utils.ts';
import { groupGrants, policyPeople } from '../policiesPeople.test-utils.ts';
import { OTHER_ORGANIZATION } from '../tokens.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import {
  insertObjects,
  NS,
  parameterValue,
  staticString,
  startActions,
  twinIr,
  type ActionsService,
  type RawAnswer,
} from './actions.test-utils.ts';

const CREW_MEMBER = `${NS}CrewMember`;
const CREW = `${NS}Crew`;
const JOBSITE = `${NS}Jobsite`;
const ONTOLOGY = `/api/v2/ontologies/${ONTOLOGY_RID}`;
const PERSON = 'ontology/action-types/submission-criteria#person-values';

const ROLES = { admin: ['ontology:install', USE, 'admin'], foreman: [USE] };

const CUSTOM_ROLES = { ...ROLES, 'org-foreman': ['twin:use', 'admin'] };

const PEOPLE = policyPeople(
  {
    ann: { sub: 'user_ann', role: 'foreman' },
    ben: { sub: 'user_ben', role: 'foreman' },
    carl: { sub: 'user_carl', role: 'foreman' },
    dan: { sub: 'user_dan', role: 'foreman' },
    admin: { sub: 'user_admin', role: 'admin' },
    upperAdmin: { sub: 'user_admin', role: 'Admin' },
    fay: { sub: 'user_fay', role: 'org-foreman' },
  },
  CUSTOM_ROLES,
);

type Person = keyof typeof PEOPLE;

const userValue = (propertyValue: unknown) => ({
  type: 'userProperty',
  userProperty: { userId: { type: 'currentUser', currentUser: {} }, propertyValue },
});

const USER_ID = userValue({ type: 'userId', userId: {} });
const PERMISSIONS = userValue({ type: 'groupIds', groupIds: {} });
const attribute = (attributeKey: string) => userValue({ type: 'userAttributes', userAttributes: { attributeKey } });

const comparison = (operator: string, left: unknown, right: unknown) => ({
  type: 'comparison',
  comparison: { operator, left, right },
});

const group = (name: string) =>
  comparison('INTERSECTS', PERMISSIONS, {
    type: 'staticValue',
    staticValue: { type: 'stringList', stringList: { strings: [name] } },
  });

const or = (...conditions: unknown[]) => ({ type: 'or', or: { conditions } });
const not = (condition: unknown) => ({ type: 'not', not: { condition } });
const ON_JOBSITE = comparison('INTERSECTS', attribute('jobsiteIds'), parameterValue('note'));

const JOBSITE_KEY = {
  type: 'objectParameterPropertyValue',
  objectParameterPropertyValue: { parameterId: 'jobsite', propertyTypeId: 'jobsiteId' },
};

const CRITERIA: Record<string, readonly [condition: unknown, failureMessage: string]> = {
  'user-is-note': [comparison('EQUALS', USER_ID, parameterValue('note')), 'Only the named person.'],
  admins: [group('admin'), 'Only an admin.'],
  'not-admin': [not(group('admin')), 'An admin cannot.'],
  'on-jobsite': [ON_JOBSITE, 'Only your jobsite.'],
  'not-on-jobsite': [not(ON_JOBSITE), 'Not your jobsite.'],
  'admin-or-jobsite': [or(group('admin'), ON_JOBSITE), 'An admin or your jobsite.'],
  'jobsite-property': [comparison('INTERSECTS', JOBSITE_KEY, attribute('jobsiteIds')), 'Only your jobsite.'],
  'no-person': [comparison('EQUALS', parameterValue('note'), staticString('go')), 'Say go.'],
};

const named = (name: string) => `${NS}person-${name}`;

const OBJECT_QUERY = { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } };
const TEXT = { type: 'text', text: { type: 'text', text: {} } };
const REQUIRED = { type: 'required', required: {} };
const NOT_REQUIRED = { type: 'notRequired', notRequired: {} };

const PARAMETERS: Record<string, { type: unknown; allowedValues: unknown; required: unknown }> = {
  crew: {
    type: { type: 'objectReference', objectReference: { objectTypeId: CREW } },
    allowedValues: OBJECT_QUERY,
    required: REQUIRED,
  },
  jobsite: {
    type: { type: 'objectReference', objectReference: { objectTypeId: JOBSITE } },
    allowedValues: OBJECT_QUERY,
    required: NOT_REQUIRED,
  },
  note: { type: { type: 'string', string: {} }, allowedValues: TEXT, required: NOT_REQUIRED },
};

const DONE = {
  type: 'modifyObjectRule',
  modifyObjectRule: {
    objectToModify: 'crew',
    propertyValues: { name: { type: 'staticValue', staticValue: { type: 'string', string: 'done' } } },
    structFieldValues: {},
  },
};

function actionType(apiName: string, [condition, failureMessage]: readonly [unknown, string]) {
  const block = structuredClone(twinIr('0.6.3').ontology.actionTypes[`${NS}set-engagement-status`]);

  if (!block) throw new Error('The twin 0.6.3 IR has no set-engagement-status.');

  const { metadata, actionTypeLogic } = block.actionType;

  metadata.apiName = apiName;
  metadata.parameters = {};
  metadata.parameterOrdering = Object.keys(PARAMETERS);

  actionTypeLogic.validation.parameterValidations = {};

  for (const [id, { type, allowedValues, required }] of Object.entries(PARAMETERS)) {
    metadata.parameters[id] = unchecked({
      id,
      type,
      displayMetadata: { displayName: id, description: '', typeClasses: [] },
    });

    actionTypeLogic.validation.parameterValidations[id] = unchecked({
      defaultValidation: {
        display: { renderHint: { type: 'textInput', textInput: {} }, visibility: { type: 'editable', editable: {} } },
        validation: { allowedValues, required },
      },
      conditionalOverrides: [],
    });
  }

  actionTypeLogic.validation.actionTypeLevelValidation.rules = {
    '0': unchecked({ condition, displayMetadata: { failureMessage, typeClasses: [] } }),
  };

  actionTypeLogic.logic.rules = unchecked([DONE]);

  return block;
}

function testIr(criteria: Record<string, readonly [unknown, string]> = CRITERIA): OntologyIr {
  const ir = attributesIr();

  for (const [name, criterion] of Object.entries(criteria))
    ir.ontology.actionTypes[named(name)] = actionType(named(name), criterion);

  return ir;
}

let service: ActionsService;
let grants: GrantsFile;

beforeAll(async () => {
  const ir = testIr();

  grants = { ...groupGrants(ir, ROLES), personAttributes: ATTRIBUTE_DECLARATIONS };

  service = await startActions(ir, undefined, grants);
});

afterAll(() => service?.stop());

beforeEach(seed);

async function seed(): Promise<void> {
  await service.clear();

  await insertObjects(
    service.db,
    CREW,
    ['crew-a', 'crew-b'].map((crewId) => ({ crewId, name: crewId })),
  );

  await insertObjects(
    service.db,
    JOBSITE,
    ['j-1', 'j-2', 'j-3'].map((jobsiteId) => ({ jobsiteId, name: jobsiteId })),
  );

  await insertObjects(service.db, CREW_MEMBER, [
    { memberId: 'm-ann', userId: 'user_ann', crewId: 'crew-a' },
    { memberId: 'm-dan', userId: 'user_dan', crewId: null },
  ]);

  for (const jobsite of ['j-1', 'j-2'])
    await service.db.query(
      sql('INSERT INTO ontology_1_objects.crew_jobsites (a_crew_id, b_jobsite_id) VALUES ($1, $2)', 'crew-a', jobsite),
    );
}

function watched(db: Db, fail = false): { readonly db: Db; readonly reads: () => number } {
  let reads = 0;

  const wrapped: Db = {
    query: <Row extends object>(statement: Sql) => {
      if (!statement.text.startsWith('SELECT ARRAY(')) return db.query<Row>(statement);

      reads += 1;

      return fail ? Promise.reject(new Error('The test fails the Person attribute read.')) : db.query<Row>(statement);
    },
    stream: <Row extends object>(statement: Sql) => db.stream<Row>(statement),
    snapshot: (run) => db.snapshot(run),
    transaction: (run) => db.transaction(run),
  };

  return { db: wrapped, reads: () => reads };
}

function apply(
  name: string,
  person: Person,
  parameters: Record<string, unknown>,
  mode?: 'VALIDATE_ONLY',
  db?: Db,
): Promise<RawAnswer> {
  const body = { parameters: { crew: 'crew-a', ...parameters }, ...(mode ? { options: { mode } } : {}) };

  return service.call('POST', `${ONTOLOGY}/actions/${named(name)}/apply`, body, {
    ...PEOPLE[person],
    ...(db ? { db } : {}),
  });
}

const crewName = async () =>
  (
    await service.db.query<{ name: string }>(sql("SELECT name FROM ontology_1_objects.crew WHERE crew_id = 'crew-a'"))
  )[0]?.name;

async function result(name: string, person: Person, parameters: Record<string, unknown> = {}): Promise<unknown> {
  const answer = await apply(name, person, parameters);

  const body =
    answer.status === 200
      ? (JSON.parse(answer.text) as {
          validation?: { result: string; submissionCriteria: { configuredFailureMessage: string }[] };
        })
      : undefined;

  if (!body) return { status: answer.status, text: answer.text };

  if (!body.validation || body.validation.result === 'VALID') return { applied: await crewName() };

  return {
    result: body.validation.result,
    messages: body.validation.submissionCriteria.map((each) => each.configuredFailureMessage),
  };
}

const APPLIED = { applied: 'done' };
const refused = (message: string) => ({ result: 'INVALID', messages: [message] });

describe('a criterion on user.id', () => {
  it(`passes for the person whose User ID the parameter holds, and fails for another person`, async () => {
    expect(await result('user-is-note', 'ben', { note: 'user_ann' })).toEqual(refused('Only the named person.'));

    expect(await crewName()).toBe('crew-a');

    expect(await result('user-is-note', 'ann', { note: 'user_ann' })).toEqual(APPLIED);
  });
});

describe('a criterion on user.permissions', () => {
  it(`the maker group condition passes for a person whose role holds the permission, and fails for a person whose role lacks it`, async () => {
    expect(await result('admins', 'ann')).toEqual(refused('Only an admin.'));

    expect(await result('admins', 'admin')).toEqual(APPLIED);
  });

  it(`service/authentication#access: a submission criterion on user.permissions passes for a custom role that holds the permission, and fails for a default role that lacks it`, async () => {
    expect(await result('admins', 'ann')).toEqual({ result: 'INVALID', messages: ['Only an admin.'] });

    expect(await crewName()).toBe('crew-a');

    expect(await result('admins', 'fay')).toEqual({ applied: 'done' });
  });

  it(`a role that WorkOS does not have, such as Admin for admin, gives no permission, so the caller gets 404 before any criterion`, async () => {
    const answer = await apply('admins', 'upperAdmin', {});

    expect({ status: answer.status, errorName: (JSON.parse(answer.text) as { errorName: string }).errorName }).toEqual({
      status: 404,
      errorName: 'ActionTypeNotFound',
    });
  });

  it(`an admin of another Organization gets the same answer for a person criterion as for a criterion with no person value`, async () => {
    const other = { ...PEOPLE.admin, claims: { ...PEOPLE.admin.claims, org_id: OTHER_ORGANIZATION } };

    const send = (name: string) =>
      service.call(
        'POST',
        `${ONTOLOGY}/actions/${named(name)}/apply`,
        { parameters: { crew: 'crew-a', note: 'go' } },
        other,
      );

    const [person, plain] = await Promise.all([send('admins'), send('no-person')]);

    const masked = (answer: RawAnswer) => ({
      status: answer.status,
      text: answer.text
        .replace(/"errorInstanceId":"[^"]+"/, '')
        .replaceAll(named('admins'), 'NAME')
        .replaceAll(named('no-person'), 'NAME'),
    });

    expect(person.status).not.toBe(200);
    expect(masked(person)).toEqual(masked(plain));

    expect(await crewName()).toBe('crew-a');
  });

  it(`${PERSON}/680a1de0: not of user.permissions INTERSECTS admin passes for a foreman and fails for an admin`, async () => {
    expect(await result('not-admin', 'admin')).toEqual(refused('An admin cannot.'));

    expect(await result('not-admin', 'ann')).toEqual(APPLIED);
  });
});

describe('a criterion on a Person attribute', () => {
  it(`${PERSON}/680a1de0: INTERSECTS passes for a Jobsite of the person, and fails for another Jobsite`, async () => {
    expect(await result('on-jobsite', 'ann', { note: 'j-3' })).toEqual(refused('Only your jobsite.'));

    expect(await result('on-jobsite', 'ann', { note: 'j-2' })).toEqual(APPLIED);
  });

  it.each([
    ['carl, a person with no start Object', 'carl'],
    ['dan, a person whose start Object has no crew', 'dan'],
  ] as const)(
    `for %s, the attribute is empty, so the criterion and its not both fail with their failure messages`,
    async (_name, person) => {
      expect(await result('on-jobsite', person, { note: 'j-1' })).toEqual(refused('Only your jobsite.'));

      expect(await result('not-on-jobsite', person, { note: 'j-1' })).toEqual(refused('Not your jobsite.'));

      expect(await crewName()).toBe('crew-a');
    },
  );

  it(`not of the attribute passes for a person with a Jobsite that is not the parameter`, async () => {
    expect(await result('not-on-jobsite', 'ann', { note: 'j-1' })).toEqual(refused('Not your jobsite.'));

    expect(await result('not-on-jobsite', 'ann', { note: 'j-3' })).toEqual(APPLIED);
  });

  it(`${PERSON}/680a1de0: an omitted note shares no String with the attribute, so INTERSECTS fails and its not passes`, async () => {
    expect(await result('on-jobsite', 'ann')).toEqual(refused('Only your jobsite.'));

    expect(await result('not-on-jobsite', 'ann')).toEqual(APPLIED);
  });

  it(`user.permissions INTERSECTS admin OR the attribute passes for an admin with no CrewMember, and fails for carl`, async () => {
    expect(await result('admin-or-jobsite', 'carl', { note: 'j-1' })).toEqual(refused('An admin or your jobsite.'));

    expect(await result('admin-or-jobsite', 'admin', { note: 'j-1' })).toEqual(APPLIED);
  });

  it.each([
    ['not-on-jobsite', 'carl'],
    ['on-jobsite', 'carl'],
    ['on-jobsite', 'ann'],
    ['admin-or-jobsite', 'carl'],
    ['admin-or-jobsite', 'ann'],
    ['user-is-note', 'carl'],
    ['user-is-note', 'ann'],
  ] as const)(
    `VALIDATE_ONLY of %s for %s gives the same answer bytes as the apply that fails`,
    async (name, person) => {
      const validate = await apply(name, person, { note: 'j-9' }, 'VALIDATE_ONLY');

      const applied = await apply(name, person, { note: 'j-9' });

      expect((JSON.parse(applied.text) as { validation: { result: string } }).validation.result).toBe('INVALID');
      expect(validate).toEqual(applied);
    },
  );

  it(`VALIDATE_ONLY of not-on-jobsite for ann returns VALID with no failed submission criteria`, async () => {
    const validate = await apply('not-on-jobsite', 'ann', { note: 'j-9' }, 'VALIDATE_ONLY');

    expect(JSON.parse(validate.text)).toMatchObject({ validation: { result: 'VALID', submissionCriteria: [] } });
  });
});

describe('the read of a Person attribute', () => {
  it(`a request of a criterion that reads an attribute makes 1 attribute read`, async () => {
    const { db, reads } = watched(service.db);

    expect((await apply('on-jobsite', 'ann', { note: 'j-1' }, undefined, db)).status).toBe(200);

    expect(reads()).toBe(1);
  });

  it(`a failed attribute read fails the request with 500 and writes nothing, and never reads as empty`, async () => {
    const { db } = watched(service.db, true);

    const answers = await Promise.all(
      ['not-on-jobsite', 'on-jobsite'].map((name) => apply(name, 'ann', { note: 'j-3' }, undefined, db)),
    );

    expect(answers.map(({ status }) => status)).toEqual([500, 500]);

    expect(await crewName()).toBe('crew-a');
  });

  it(`a criterion with no person value sends the same statements with and without the person`, async () => {
    const texts: string[] = [];

    const db: Db = {
      ...service.db,
      query: <Row extends object>(statement: Sql) => (texts.push(statement.text), service.db.query<Row>(statement)),
    };

    expect(await result('no-person', 'ann', { note: 'stop' })).toEqual(refused('Say go.'));

    await apply('no-person', 'ann', { note: 'stop' }, undefined, db);

    const first = [...texts];

    texts.length = 0;

    await apply('no-person', 'admin', { note: 'stop' }, undefined, db);

    expect(texts.filter((text) => !text.startsWith('SELECT ARRAY('))).toEqual(
      first.filter((text) => !text.startsWith('SELECT ARRAY(')),
    );
  });
});

describe('a criterion on a Property of a hidden Object', () => {
  it(`a hidden Jobsite gives the same answer bytes as a missing one, and the criterion never runs`, async () => {
    const hidden = await apply('jobsite-property', 'ann', { jobsite: 'j-3' });

    const missing = await apply('jobsite-property', 'ann', { jobsite: 'j-404' });

    expect(hidden.status).toBe(404);

    const masked = (text: string) => text.replace(/"errorInstanceId":"[^"]+"/, '"errorInstanceId":"ID"');

    expect(masked(hidden.text)).toBe(masked(missing.text));

    expect(await result('jobsite-property', 'ann', { jobsite: 'j-1' })).toEqual(APPLIED);
  });
});

describe('a publish of a criterion that reads a Person attribute', () => {
  const versions = async () =>
    (
      await service.db.query<{ version: number }>(
        sql("SELECT version FROM ontology_registry.product_versions WHERE product = 'twin' ORDER BY version"),
      )
    ).map((row) => row.version);

  it.each(['regionIds', 'toString', 'constructor', '__proto__', 'hasOwnProperty'])(
    `the publish route refuses a criterion on the undeclared attribute %s with 400 part grants, and stores no version`,
    async (name) => {
      const ir = testIr({
        ...CRITERIA,
        extra: [comparison('INTERSECTS', attribute(name), parameterValue('note')), 'No.'],
      });

      const before = await versions();

      const answer = await service
        .publish(ir, undefined, { ...groupGrants(ir, ROLES), personAttributes: ATTRIBUTE_DECLARATIONS })
        .then(
          () => 'stored',
          (error: Error) => error.message,
        );

      const prefix = 'The publish gave 400: ';

      expect(answer.startsWith(prefix)).toBe(true);

      expect(JSON.parse(answer.slice(prefix.length))).toMatchObject({
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'Default:InvalidArgument',
        parameters: {
          part: 'grants',
          problems: [
            `A Submission criterion of the Action Type ${named('extra')} reads the Person attribute ${name}, which personAttributes does not declare.`,
          ],
        },
      });

      expect(await versions()).toEqual(before);
    },
  );
});
