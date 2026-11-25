import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { quoteName, type Sql } from '../db/index.ts';
import { tableName } from '../ontology/index.ts';
import {
  errorAnswer,
  NS,
  ONTOLOGY_RID,
  rowsOf,
  seedClient,
  startActions,
  twinFunctions,
  twinIr,
  type ActionsService,
  type Answer,
} from '../actions/actions.test-utils.ts';
import { convertOrThrow, grantsOf, stored, unchecked } from '../ontology/stored.test-utils.ts';

import { APPLY, expectAllOnNewest, PUBLISHER, publishOntology, readRequest, type Db } from './publish.test-utils.ts';

const ENGAGEMENT = `${NS}Engagement`;
const ENGAGEMENTS = `${quoteName('ontology_1_objects')}.${quoteName(tableName(ENGAGEMENT))}`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const EXECUTE_NONE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const OBJECT_CHANGED = { status: 409, body: { errorCode: 'CONFLICT', errorName: 'ObjectChanged', parameters: {} } };
const STATUSES = ['open', 'won', 'lost'];

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(twinIr('0.6.3'), twinFunctions('0.6.3'));
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await seedClient(service.db);
});

afterEach(() => expectAllOnNewest(service.db));

function withStatusValueType(): OntologyIr {
  const ir = twinIr('0.6.3');
  const constraint = { type: 'string', string: { type: 'oneOf', oneOf: { values: STATUSES, useIgnoreCase: false } } };

  const definition = {
    metadata: {
      apiName: 'engagementStatus',
      displayMetadata: { displayName: 'Engagement status', description: '' },
      status: { type: 'active', active: {} },
    },
    versions: [
      {
        version: '1.0.0',
        baseType: { type: 'string', string: {} },
        constraints: [{ constraint: { constraint } }],
        exampleValues: [],
      },
    ],
  };

  const status = ir.ontology.objectTypes[ENGAGEMENT]?.objectType.propertyTypes['status'];

  if (!status) throw new Error('The twin 0.6.3 IR has no Engagement status.');

  Object.assign(
    status,
    unchecked({
      valueType: { apiName: 'engagementStatus', version: '1.0.0' },
      dataConstraints: { propertyTypeConstraints: [{ constraints: constraint }] },
    }),
  );

  return { ...ir, valueTypes: unchecked({ valueTypes: [definition] }) };
}

async function publish(ir: OntologyIr, whileLocked: () => Promise<void>): Promise<void> {
  const body = {
    ir,
    product: 'twin',
    schemaMigrations: { migrations: [] },
    osdkSet: stored(ir).osdkSet,
    grants: grantsOf(ir),
    validateOnly: false,
    functions: twinFunctions('0.6.3'),
  };

  const request = readRequest(JSON.parse(JSON.stringify(body)) as Parameters<typeof readRequest>[0]);

  const holding: Db = {
    ...service.db,
    transaction: (run) =>
      service.db.transaction((tx) =>
        run({
          ...tx,
          query: async <Row extends object>(statement: Sql) => {
            const rows = await tx.query<Row>(statement);

            if (statement.text === `LOCK TABLE ${ENGAGEMENTS} IN SHARE MODE`) await whileLocked();

            return rows;
          },
        }),
      ),
  };

  const response = await publishOntology(holding, {
    product: 'twin',
    productRid: ONTOLOGY_RID,
    ontology: convertOrThrow(request, ONTOLOGY_RID, 2),
    request,
    publisher: PUBLISHER,
    mode: APPLY,
  });

  expect(response.version).toBe(2);
}

async function lockWaitOnEngagements(): Promise<void> {
  for (let tries = 0; tries < 250; tries += 1) {
    const [row] = await service.db.query<{ waiting: number }>({
      text: 'SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted AND relation = $1::regclass',
      values: [ENGAGEMENTS],
    });

    if ((row?.waiting ?? 0) > 0) return;

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`No session waited for a lock on ${ENGAGEMENTS}.`);
}

const answerOf = (answer: Answer) => (answer.status === 200 ? answer : errorAnswer(answer));

describe('a write that waits for the table lock of a publish that tightens a value type', () => {
  it('ontology/object-link-types/value-types#check-at-publish: the write gets 409 ObjectChanged after the publish commits, and each stored value passes the new value type', async () => {
    let applied: Promise<Answer> | undefined;

    await publish(withStatusValueType(), async () => {
      applied = service.apply(SET_ENGAGEMENT_STATUS, {
        parameters: { objectToModifyParameter: 'eng-2', status: 'paused' },
        options: EXECUTE_NONE,
      });

      await lockWaitOnEngagements();
    });

    if (!applied) throw new Error('The publish locked no Engagement table.');

    expect(answerOf(await applied)).toEqual(OBJECT_CHANGED);

    const statuses = (await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).map((row) => row['status']);

    expect(statuses).toEqual(['won', 'open', 'open', 'lost', 'won', 'open']);
    expect(statuses.every((status) => typeof status === 'string' && STATUSES.includes(status))).toBe(true);
  });
});
