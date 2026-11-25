import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Sql } from '../db/index.ts';
import type { Db } from '../db/promise.test-utils.ts';
import { testIr } from './parametersSupport.test-utils.ts';
import { registryDb } from './stubActions.test-utils.ts';
import { startActions, twinFunctions, type ActionsService } from './actions.test-utils.ts';

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(testIr(), twinFunctions('0.6.3'));
});

afterAll(() => service?.stop());

function recording(db: Db): { readonly db: Db; readonly statements: Sql[] } {
  const statements: Sql[] = [];

  return {
    statements,
    db: {
      query: (statement) => {
        statements.push(statement);

        return db.query(statement);
      },
      stream: (statement) => {
        statements.push(statement);

        return db.stream(statement);
      },
      transaction: (run) => db.transaction(run),
      snapshot: (run) => db.snapshot(run),
    },
  };
}

it('each registry read of the apply route gives the same rows from the stub as from a real publish of testIr()', async () => {
  const real = recording(service.db);

  const answer = await service.apply('nope', { parameters: {}, options: {} }, { db: real.db });

  expect(answer.status).toBe(404);

  expect(real.statements.map(({ text }) => text.match(/FROM ontology_registry\.\w+/)?.[0])).toEqual([
    'FROM ontology_registry.ontologies',
    'FROM ontology_registry.product_versions',
  ]);

  const [{ database } = { database: '' }] = await service.db.query<{ database: string }>({
    text: 'SELECT current_database() AS database',
    values: [],
  });

  const stub = registryDb(testIr(), twinFunctions('0.6.3'), database);

  for (const statement of real.statements) {
    const [stored] = await service.db.query<Record<string, unknown>>(statement);

    const [stubbed] = (await stub.db.query<Record<string, unknown>>(statement)).map(
      (row) => JSON.parse(JSON.stringify(row)) as Record<string, unknown>,
    );

    if (!stored || !stubbed) throw new Error(`No row for ${statement.text}`);

    expect(Object.keys(stubbed).sort()).toEqual(Object.keys(stored).sort());

    for (const column of Object.keys(stored)) expect(stubbed[column], column).toEqual(stored[column]);
  }

  expect(stub.unexpected).toEqual([]);
});
