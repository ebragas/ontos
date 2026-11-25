import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NS, rowsOf, startActions, twinFunctions, twinIr, type ActionsService } from './actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const SET_ACCOUNT_PHASE = `${NS}set-account-phase`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };
const VALIDATE_ONLY = { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' };
const ACTION_RID = /^ri\.actions\.main\.action\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(twinIr('0.7.0'), twinFunctions('0.7.0'));
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  const steps: [string, Record<string, unknown>][] = [
    [`${NS}create-account`, { accountId: 'p-om-a1', name: 'issue p-om-a1' }],
    [`${NS}create-account`, { accountId: 'p-om-a2', name: 'issue p-om-a2' }],
    [`${NS}create-engagement`, { engagementId: 'p-om-e3', accountId: 'p-om-a1', title: 'issue p-om-e3', amount: 1 }],
    [`${NS}create-engagement`, { engagementId: 'p-om-e4', accountId: 'p-om-a1', title: 'issue p-om-e4', amount: 1 }],
    [SET_ACCOUNT_PHASE, { objectToModifyParameter: 'p-om-a1', phase: 'customer' }],
    [SET_ACCOUNT_PHASE, { objectToModifyParameter: 'p-om-a2', phase: 'customer' }],
    [SET_ENGAGEMENT_STATUS, { objectToModifyParameter: 'p-om-e3', status: 'open' }],
    [SET_ENGAGEMENT_STATUS, { objectToModifyParameter: 'p-om-e4', status: 'open' }],
  ];

  for (const [actionType, parameters] of steps) {
    const answer = await service.apply(actionType, { parameters, options: EXECUTE });

    if (answer.status !== 200)
      throw new Error(`The start step ${actionType} gave ${answer.status}: ${JSON.stringify(answer.body)}`);
  }
});

const accounts = async () =>
  (await rowsOf(service.db, ACCOUNT, 'account_id')).map(({ account_id, name, phase }) => ({ account_id, name, phase }));

const engagements = async () =>
  (await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).map(
    ({ engagement_id, account_id, title, amount, status }) => ({ engagement_id, account_id, title, amount, status }),
  );

const modified = (objectType: string, primaryKey: string) => ({
  status: 200,
  body: {
    operationId: expect.stringMatching(ACTION_RID),
    validation: { result: 'VALID', submissionCriteria: [], parameters: {} },
    edits: {
      type: 'edits',
      edits: [{ type: 'modifyObject', primaryKey, objectType }],
      addedObjectCount: 0,
      modifiedObjectsCount: 1,
      deletedObjectsCount: 0,
      addedLinksCount: 0,
      deletedLinksCount: 0,
    },
  },
});

describe('a modify with an omitted parameter or the value null', () => {
  it('ontology/action-types/action-types#apply, ontology/action-types/rules#values: call 1, set-account-phase with phase omitted, keeps "customer"', async () => {
    const answer = await service.apply(SET_ACCOUNT_PHASE, {
      parameters: { objectToModifyParameter: 'p-om-a1' },
      options: EXECUTE,
    });

    expect(answer).toEqual(modified(ACCOUNT, 'p-om-a1'));

    expect(await accounts()).toEqual([
      { account_id: 'p-om-a1', name: 'issue p-om-a1', phase: 'customer' },
      { account_id: 'p-om-a2', name: 'issue p-om-a2', phase: 'customer' },
    ]);
  });

  it('ontology/action-types/action-types#apply, ontology/action-types/rules#values: call 2, set-account-phase with "phase": null, clears phase', async () => {
    const answer = await service.apply(SET_ACCOUNT_PHASE, {
      parameters: { objectToModifyParameter: 'p-om-a2', phase: null },
      options: EXECUTE,
    });

    expect(answer).toEqual(modified(ACCOUNT, 'p-om-a2'));

    expect(await accounts()).toEqual([
      { account_id: 'p-om-a1', name: 'issue p-om-a1', phase: 'customer' },
      { account_id: 'p-om-a2', name: 'issue p-om-a2', phase: null },
    ]);
  });

  it('ontology/action-types/action-types#apply, ontology/action-types/rules#values: call 3, set-engagement-status with status omitted, keeps "open"', async () => {
    const answer = await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'p-om-e3' },
      options: EXECUTE,
    });

    expect(answer).toEqual(modified(ENGAGEMENT, 'p-om-e3'));

    expect(await engagements()).toEqual([
      { engagement_id: 'p-om-e3', account_id: 'p-om-a1', title: 'issue p-om-e3', amount: 1, status: 'open' },
      { engagement_id: 'p-om-e4', account_id: 'p-om-a1', title: 'issue p-om-e4', amount: 1, status: 'open' },
    ]);
  });

  it('ontology/action-types/action-types#apply, ontology/action-types/rules#values: call 4, set-engagement-status with "status": null, clears status', async () => {
    const answer = await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'p-om-e4', status: null },
      options: EXECUTE,
    });

    expect(answer).toEqual(modified(ENGAGEMENT, 'p-om-e4'));

    expect(await engagements()).toEqual([
      { engagement_id: 'p-om-e3', account_id: 'p-om-a1', title: 'issue p-om-e3', amount: 1, status: 'open' },
      { engagement_id: 'p-om-e4', account_id: 'p-om-a1', title: 'issue p-om-e4', amount: 1, status: null },
    ]);
  });
});

describe('VALIDATE_ONLY with a default value', () => {
  const VALIDATION = {
    result: 'VALID',
    submissionCriteria: [],
    parameters: {
      phase: { result: 'VALID', evaluatedConstraints: [], required: false, defaultValue: 'customer' },
      objectToModifyParameter: {
        result: 'VALID',
        evaluatedConstraints: [{ type: 'objectQueryResult' }],
        required: true,
      },
    },
  };

  it.each([
    ['phase omitted', { objectToModifyParameter: 'p-om-a1' }],
    ['"phase": null', { objectToModifyParameter: 'p-om-a2', phase: null }],
  ])(
    'ontology/action-types/action-types#apply: gives the default value as defaultValue with %s, and writes nothing',
    async (_name, parameters) => {
      const answer = await service.apply(SET_ACCOUNT_PHASE, { parameters, options: VALIDATE_ONLY });

      expect(answer).toEqual({ status: 200, body: { validation: VALIDATION } });

      expect(await accounts()).toEqual([
        { account_id: 'p-om-a1', name: 'issue p-om-a1', phase: 'customer' },
        { account_id: 'p-om-a2', name: 'issue p-om-a2', phase: 'customer' },
      ]);
    },
  );
});
