import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CompiledLinkType, CompiledOntology } from '../ontology/index.ts';
import type { PublishResponse } from '../publish/index.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { joinedTechnicianWorkOrders, realCompile } from '../publish/realCompile.test-utils.ts';
import {
  foreignKey,
  NAMESPACE,
  newDatabase,
  objectType,
  ontology,
  property,
  publishAndInstall,
  PUBLISHER,
  request,
  sql,
  technician,
  type TestDatabase,
  APPLY,
  expectAllOnNewest,
} from '../publish/publish.test-utils.ts';
import { TEST_PRODUCT } from '../service.test-utils.ts';

let postgres: TestPostgres;
let database: TestDatabase;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await newDatabase(postgres.url);
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  await database.end();
});

function publish(literal: CompiledOntology): Promise<PublishResponse> {
  const { ontology: compiled, ir } = realCompile(literal);

  return publishAndInstall(database.db, {
    ...TEST_PRODUCT,
    ontology: compiled,
    request: { ...request(false), ir, schemaMigrations: { migrations: [] } },
    publisher: PUBLISHER,
    mode: APPLY,
  });
}

const linkedWorkOrder = objectType(`${NAMESPACE}WorkOrder`, 'work_order', 'workOrderId', [
  property('workOrderId', 'work_order_id', { kind: 'string' }, true),
  property('assignedTechnicianId', 'assigned_technician_id', { kind: 'string' }),
  property('reviewerId', 'reviewer_id', { kind: 'string' }),
]);

const part = objectType(`${NAMESPACE}Part`, 'part', 'partId', [
  property('partId', 'part_id', { kind: 'string' }, true),
]);

const assignedTechnician: CompiledLinkType = {
  apiName: 'assignedTechnician',
  rid: 'ri.ontology.main.relation.assignedTechnician',
  status: 'experimental',
  storage: foreignKey(linkedWorkOrder, 'assignedTechnicianId', technician),
};

async function indexOids(): Promise<Record<string, number>> {
  const rows = await database.db.query<{ key: string; oid: number }>(
    sql(
      `SELECT t.relname || '(' || array_to_string(array(
                SELECT a.attname FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, n)
                  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.n), ',') || ')' AS key,
              i.indexrelid::int AS oid
         FROM pg_index i
         JOIN pg_class t ON t.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'ontology_1_objects' AND NOT i.indisprimary`,
    ),
  );

  return Object.fromEntries(rows.map((row) => [row.key, row.oid]));
}

const descriptions = (response: PublishResponse) => response.changes.map((change) => change.description);

describe('the Link Type decisions of a publish', () => {
  it('service/storage#indexes: a publish keeps an unchanged Link Type: it makes no table or index change, and the Links stay', async () => {
    const linkTypes = [assignedTechnician, joinedTechnicianWorkOrders];

    await publish(ontology({ objectTypes: [linkedWorkOrder, technician], linkTypes }));

    await database.db.query(
      sql(`INSERT INTO ontology_1_objects.work_order (work_order_id, assigned_technician_id) VALUES ('wo-1', 't-1')`),
    );

    await database.db.query(
      sql(
        `INSERT INTO ontology_1_objects.technician_work_orders (a_technician_id, b_work_order_id) VALUES ('t-1', 'wo-1')`,
      ),
    );

    const before = await indexOids();

    const response = await publish(ontology({ objectTypes: [linkedWorkOrder, technician, part], linkTypes }));

    expect(descriptions(response)).toEqual([`Create Object Type ${part.apiName}`]);

    expect(await indexOids()).toEqual(before);

    const links = await database.db.query(
      sql(`SELECT a_technician_id, b_work_order_id FROM ontology_1_objects.technician_work_orders`),
    );

    expect(links).toEqual([{ a_technician_id: 't-1', b_work_order_id: 'wo-1' }]);
  });

  it('service/storage#indexes: a publish keeps a one-to-many Link Type whose foreign key Property becomes required: it makes no Link Type change', async () => {
    await publish(ontology({ objectTypes: [linkedWorkOrder, technician], linkTypes: [assignedTechnician] }));

    const before = await indexOids();

    expect(Object.keys(before)).toContain('work_order(assigned_technician_id)');

    const requiredKey = objectType(linkedWorkOrder.apiName, 'work_order', 'workOrderId', [
      property('workOrderId', 'work_order_id', { kind: 'string' }, true),
      property('assignedTechnicianId', 'assigned_technician_id', { kind: 'string' }, true),
      property('reviewerId', 'reviewer_id', { kind: 'string' }),
    ]);

    const kept: CompiledLinkType = {
      ...assignedTechnician,
      storage: foreignKey(requiredKey, 'assignedTechnicianId', technician),
    };

    const response = await publish(ontology({ objectTypes: [requiredKey, technician], linkTypes: [kept] }));

    expect(descriptions(response)).toEqual([
      `Make Property assignedTechnicianId required of Object Type ${linkedWorkOrder.apiName}`,
    ]);

    expect(await indexOids()).toEqual(before);
  });

  it('service/storage#indexes: a new one-to-many Link Type on a column that the current version has creates the index of that column', async () => {
    await publish(ontology({ objectTypes: [linkedWorkOrder, technician] }));

    expect(await indexOids()).toEqual({});

    const response = await publish(
      ontology({ objectTypes: [linkedWorkOrder, technician], linkTypes: [assignedTechnician] }),
    );

    expect(descriptions(response)).toEqual([`Create Link Type ${assignedTechnician.apiName}`]);

    expect(Object.keys(await indexOids())).toEqual(['work_order(assigned_technician_id)']);
  });

  it('service/storage#indexes: a one-to-many Link Type that moves to another foreign key Property drops the old index and creates the new one', async () => {
    await publish(ontology({ objectTypes: [linkedWorkOrder, technician], linkTypes: [assignedTechnician] }));

    const moved: CompiledLinkType = {
      ...assignedTechnician,
      storage: foreignKey(linkedWorkOrder, 'reviewerId', technician),
    };

    const response = await publish(ontology({ objectTypes: [linkedWorkOrder, technician], linkTypes: [moved] }));

    expect(descriptions(response)).toEqual([
      `Delete Link Type ${assignedTechnician.apiName}`,
      `Create Link Type ${assignedTechnician.apiName}`,
    ]);

    expect(Object.keys(await indexOids())).toEqual(['work_order(reviewer_id)']);
  });

  it('service/storage#indexes: a deleted one-to-many Link Type drops the index, and its foreign key Property column keeps its values', async () => {
    await publish(ontology({ objectTypes: [linkedWorkOrder, technician], linkTypes: [assignedTechnician] }));

    await database.db.query(
      sql(`INSERT INTO ontology_1_objects.work_order (work_order_id, assigned_technician_id) VALUES ('wo-1', 't-1')`),
    );

    const response = await publish(ontology({ objectTypes: [linkedWorkOrder, technician] }));

    expect(descriptions(response)).toEqual([`Delete Link Type ${assignedTechnician.apiName}`]);

    expect(await indexOids()).toEqual({});

    expect(await database.db.query(sql(`SELECT assigned_technician_id FROM ontology_1_objects.work_order`))).toEqual([
      { assigned_technician_id: 't-1' },
    ]);
  });
});
