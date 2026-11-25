import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimsOf } from '../people.test-utils.ts';
import { splitGrants } from '../roles.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import {
  account,
  insertObjects,
  manyToManyLink,
  NS,
  ONTOLOGY_RID,
  startActions,
  twinFunctions,
  twinIr,
  type ActionsService,
} from './actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const DELETE_ENGAGEMENT = `${NS}delete-engagement`;
const DELETE_ACCOUNT = `${NS}delete-account`;

const SPONSORS = manyToManyLink(
  'engagement-sponsors',
  { type: ENGAGEMENT, key: 'engagementId', side: 'sponsors' },
  { type: ACCOUNT, key: 'accountId', side: 'sponsoredEngagements' },
);

function testIr() {
  const ir = twinIr('0.6.3');

  ir.ontology.linkTypes[SPONSORS.linkType.id] = SPONSORS;

  return ir;
}

let service: ActionsService;

beforeAll(async () => {
  const ir = testIr();

  service = await startActions(ir, twinFunctions('0.6.3'), splitGrants(ir));
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await insertObjects(service.db, ACCOUNT, [
    account('acc-1', 'Acme', 'customer'),
    account('acc-2', 'Globex', 'prospect'),
  ]);

  await insertObjects(service.db, ENGAGEMENT, [
    { engagementId: 'eng-1', accountId: 'acc-1', title: 'Discovery workshop' },
    { engagementId: 'eng-2', accountId: 'acc-1', title: 'Ontology build' },
  ]);

  await service.db.query(
    sql(
      "INSERT INTO ontology_1_objects.engagement_sponsors (a_engagement_id, b_account_id) VALUES ('eng-1', 'acc-1'), ('eng-1', 'acc-2'), ('eng-2', 'acc-2')",
    ),
  );
});

const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };
const MEMBER = { claims: claimsOf('member') };
const ADMIN = { claims: claimsOf('admin') };

function joinRows(): Promise<{ a_engagement_id: string; b_account_id: string }[]> {
  return service.db.query(
    sql(
      'SELECT a_engagement_id, b_account_id FROM ontology_1_objects.engagement_sponsors ORDER BY a_engagement_id, b_account_id',
    ),
  );
}

describe('a delete on a view that hides the Link Type', () => {
  it('the member cannot see the Link Type, and its delete of eng-1 clears the 2 join rows of eng-1', async () => {
    const metadata = await service.call(
      'GET',
      `/api/v2/ontologies/${ONTOLOGY_RID}/objectTypes/${ENGAGEMENT}/fullMetadata`,
      undefined,
      MEMBER,
    );

    expect((JSON.parse(metadata.text) as { linkTypes: unknown }).linkTypes).toEqual([]);

    const answer = await service.apply(
      DELETE_ENGAGEMENT,
      { parameters: { objectToDeleteParameter: 'eng-1' }, options: EXECUTE },
      MEMBER,
    );

    expect(answer.status).toBe(200);

    expect(
      (answer.body as { edits: { edits: unknown[]; deletedObjectsCount: number; deletedLinksCount: number } }).edits,
    ).toMatchObject({
      edits: [{ type: 'deleteObject', primaryKey: 'eng-1', objectType: ENGAGEMENT }],
      deletedObjectsCount: 1,
      deletedLinksCount: 0,
    });

    expect(await joinRows()).toEqual([{ a_engagement_id: 'eng-2', b_account_id: 'acc-2' }]);
  });

  it('the admin sees the Link Type, and its delete of acc-2 clears the 2 join rows of acc-2', async () => {
    const metadata = await service.call(
      'GET',
      `/api/v2/ontologies/${ONTOLOGY_RID}/objectTypes/${ENGAGEMENT}/fullMetadata`,
      undefined,
      ADMIN,
    );

    expect(
      (JSON.parse(metadata.text) as { linkTypes: { apiName: string }[] }).linkTypes.map((side) => side.apiName).sort(),
    ).toEqual(['account', 'sponsors']);

    const answer = await service.apply(
      DELETE_ACCOUNT,
      { parameters: { objectToDeleteParameter: 'acc-2' }, options: EXECUTE },
      ADMIN,
    );

    expect(answer.status).toBe(200);

    expect(await joinRows()).toEqual([{ a_engagement_id: 'eng-1', b_account_id: 'acc-1' }]);
  });
});
