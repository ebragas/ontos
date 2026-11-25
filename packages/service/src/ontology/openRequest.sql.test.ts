import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../db/index.ts';
import type { Db } from '../db/promise.test-utils.ts';
import { startActions, type ActionsService } from '../actions/actions.test-utils.ts';
import { actionOf } from '../functions/functions.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { asSnapshot } from '../service.test-utils.ts';
import { attributeGrants, JOBSITE, ONTOLOGY, PEOPLE, seedAttributes, twin } from './attributes.test-utils.ts';

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await twin();

  service = await startActions(ir, functions, attributeGrants(ir));
});

afterAll(() => service?.stop());

beforeEach(() => seedAttributes(service));

function recording(): { readonly db: Db; readonly statements: Sql[] } {
  const statements: Sql[] = [];

  const recorded = (db: Db): Db => ({
    query: <Row extends object>(statement: Sql) => {
      statements.push(statement);

      return db.query<Row>(statement);
    },
    stream: <Row extends object>(statement: Sql) => {
      statements.push(statement);

      return db.stream<Row>(statement);
    },
    transaction: (run) => db.transaction((tx) => run(recorded(tx))),
    snapshot: (run) => db.snapshot((tx) => run(asSnapshot(recorded(tx)))),
  });

  return { db: recorded(service.db), statements };
}

function stepOf(statement: Sql): string {
  if (statement.text.includes('ontology_registry.')) return 'openOntology';

  if (statement.text.startsWith('SELECT ARRAY(')) return 'openReader';

  if (statement.text.includes('"ontology_1_objects"."jobsite"')) return 'jobsites';

  return 'other';
}

const stepsOf = (statements: readonly Sql[]) =>
  statements.map(stepOf).filter((step, index, steps) => step !== steps[index - 1]);

const reads = (statements: readonly Sql[]) => statements.filter((statement) => stepOf(statement) === 'openReader');
const jobsiteReads = (statements: readonly Sql[]) => statements.filter((statement) => stepOf(statement) === 'jobsites');

async function boundKeys(statements: readonly Sql[]): Promise<unknown> {
  const [read] = reads(statements);

  if (read === undefined) throw new Error('The request read no Person attribute.');

  const [row] = await service.db.query<Record<string, unknown>>(read);

  return row?.['a0'];
}

describe('service/code-layout#seams: the reader is bound before the route runs', () => {
  it('service/code-layout#seams: an OSDK route runs after openOntology, then openReader, with the Reader that openReader bound', async () => {
    const { db, statements } = recording();

    const body = {
      objectSet: { type: 'base', objectType: JOBSITE },
      select: ['jobsiteId'],
      orderBy: { fields: [{ field: 'jobsiteId', direction: 'asc' }] },
      excludeRid: true,
    };

    const answer = await service.call('POST', `${ONTOLOGY}/objectSets/loadObjects`, body, { ...PEOPLE.ann, db });

    expect(answer.status).toBe(200);
    expect(stepsOf(statements)).toEqual(['openOntology', 'openReader', 'jobsites']);

    const keys = await boundKeys(statements);

    expect(keys).toEqual(['j-1', 'j-2']);
    expect(jobsiteReads(statements).map((statement) => statement.values)).toEqual([expect.arrayContaining([keys])]);
  });

  it('service/code-layout#seams: a request of a Function client binds no Reader of its own, and runs with the Reader of its Action', async () => {
    const { db, statements } = recording();

    const applied = await service.apply(
      actionOf('readJobsites'),
      { parameters: { note: 'ann' }, options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' } },
      { ...PEOPLE.ann, db },
    );

    expect(applied.status).toBe(200);
    expect(reads(statements)).toHaveLength(1);

    const keys = await boundKeys(statements);

    expect(jobsiteReads(statements).map((statement) => statement.values)).toEqual([expect.arrayContaining([keys])]);

    const [row] = await service.db.query<{ name: string }>(
      sql("SELECT name FROM ontology_1_objects.crew WHERE crew_id = 'crew-d'"),
    );

    expect(JSON.parse(row?.name ?? 'null')).toEqual({ note: 'ann', jobsites: ['j-1', 'j-2'] });
  });
});
