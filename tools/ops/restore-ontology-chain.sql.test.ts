import net from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OntologyIr, OntologyIrObjectTypeBlockDataV2 } from '@osdk/client.unstable';
import type { Db } from '../../packages/service/src/db/promise.test-utils.ts';
import type { SchemaMigration } from '../../packages/service/src/publish/index.ts';
import { installOntology } from '../../packages/service/src/install.test-utils.ts';
import type { PublishInput } from '../../packages/service/src/publish/publishOntology.ts';
import { convertOrThrow, irOf, NS, twinObjectType } from '../../packages/service/src/ontology/stored.test-utils.ts';
import { TEST_ONTOLOGY_RID } from '../../packages/service/src/service.test-utils.ts';
import {
  APPLY,
  expectAllOnNewest,
  NO_GRANTS,
  OSDK_SET,
  publishOntology,
  PUBLISHER,
  restoreSwitch,
  sql,
  waitForLockWaits,
} from '../../packages/service/src/publish/publish.test-utils.ts';
import {
  catalog,
  columnsByRow,
  createRestoreHarness,
  holdRowLock,
  holdTableLock,
  NEW_ENGINE,
  NEW_OBJECTS,
  recording,
  row,
  type Run,
} from './restore-ontology.test-utils.ts';

const h = createRestoreHarness('chain', { seedPair: false });

beforeAll(() => h.beforeAll());

afterAll(() => h.afterAll());

beforeEach(() => h.beforeEach());

afterEach(async () => {
  try {
    for (const db of h.productions()) await expectAllOnNewest(db);
  } finally {
    await h.cleanup();
  }
});

describe('the chain of a restore', () => {
  const ACCOUNT = `${NS}Account`;
  const RID = 'ri.ontology.main.ontology.p3';

  const PHASE_TO_STAGE: SchemaMigration = {
    type: 'renameProperty',
    objectType: ACCOUNT,
    source: 'phase',
    target: 'stage',
  };

  const REQUIRED = { nullabilityV2: { noNulls: true, noEmptyCollections: false }, propertyTypeConstraints: [] };
  const MARKER = 'restore-stored-value-marker';
  const WRITE_P3 = ['restore', RID, '--write', '--confirm-rid', RID];

  const live = (version: number) => ({
    objectSchema: 'ontology_1_objects',
    engineSchema: 'ontology_1_engine',
    version,
    engineChangeCount: 3,
  });

  const copy = (version: number) => ({
    objectSchema: NEW_OBJECTS,
    engineSchema: NEW_ENGINE,
    version,
    engineChangeCount: 3,
  });

  function account(change: (block: OntologyIrObjectTypeBlockDataV2) => void = () => undefined): OntologyIr {
    const block = twinObjectType('Account');
    const phase = block.objectType.propertyTypes['phase'];

    if (phase) phase.status = { type: 'experimental', experimental: {} };

    change(block);

    return irOf(block);
  }

  function staged(block: OntologyIrObjectTypeBlockDataV2): void {
    const phase = block.objectType.propertyTypes['phase'];

    if (!phase) return;

    delete block.objectType.propertyTypes['phase'];

    block.objectType.propertyTypes['stage'] = { ...phase, apiName: 'stage' };
  }

  const v2 = () => account(staged);

  const v3 = () =>
    account((block) => {
      staged(block);

      const stage = block.objectType.propertyTypes['stage'];

      if (stage) block.objectType.propertyTypes['region'] = { ...stage, apiName: 'region' };
    });

  const v3StageRequired = () =>
    account((block) => {
      staged(block);

      const stage = block.objectType.propertyTypes['stage'];

      if (stage) stage.dataConstraints = REQUIRED;
    });

  function publish(db: Db, ir: OntologyIr, migrations: readonly SchemaMigration[] = []): Promise<unknown> {
    const input: PublishInput = {
      product: 'twin',
      productRid: TEST_ONTOLOGY_RID,
      ontology: convertOrThrow({ ir, osdkSet: OSDK_SET, validateOnly: false }, TEST_ONTOLOGY_RID, 1),
      request: {
        product: 'twin',
        ir: JSON.parse(JSON.stringify(ir)),
        schemaMigrations: { migrations },
        osdkSet: OSDK_SET,
        grants: NO_GRANTS,
        validateOnly: false,
      },
      publisher: PUBLISHER,
      mode: APPLY,
    };

    return publishOntology(db, input);
  }

  async function installed(): Promise<{ production: { url: string; db: Db }; branch: { url: string; db: Db } }> {
    const production = await h.newDatabase('p3direct');

    const branch = await h.newDatabase('p3source');

    h.productions().push(production.db);

    for (const { db } of [production, branch]) {
      await publish(db, account());

      await installOntology(db, { rid: RID, product: 'twin', apiName: 'p3', displayName: 'p3', organization: 'org_1' });

      await db.query(
        sql("INSERT INTO ontology_1_objects.account (account_id, name, phase) VALUES ('acc-1', 'First', 'lead')"),
      );
    }

    return { production, branch };
  }

  function restore(
    production: { url: string },
    branch: { url: string },
    args: readonly string[] = WRITE_P3,
  ): Promise<Run> {
    return h.run(args, {}, { DATABASE_URL_DIRECT: production.url, RESTORE_SOURCE_URL: branch.url });
  }

  function accounts(db: Db, schema: string, columns: string): Promise<unknown[]> {
    return db.query(sql(`SELECT ${columns} FROM ${schema}.account ORDER BY account_id`));
  }

  afterEach(async () => {
    await h.asAdmin(`ALTER ROLE ${h.role} RESET ALL`);
  });

  it('service/storage#restore: a copy on the newest version switches with no step, so its tables equal the tables of the source', async () => {
    const { production, branch } = await installed();

    const result = await restore(production, branch);

    expect(result).toEqual({
      code: 0,
      stdout: [JSON.stringify({ ontologyRid: RID, from: live(1), to: copy(1), copyVersion: 1, orphans: [] })],
      stderr: [],
    });

    expect(await catalog(production.db, NEW_OBJECTS)).toEqual(await catalog(branch.db, 'ontology_1_objects'));

    expect(await accounts(production.db, NEW_OBJECTS, 'account_id, name, phase')).toEqual([
      { account_id: 'acc-1', name: 'First', phase: 'lead' },
    ]);
  });

  it('service/storage#restore: a copy that is 1 version old ends on the newest version, and its 1 step ran on the copied schemas', async () => {
    const { production, branch } = await installed();

    await publish(production.db, v2(), [PHASE_TO_STAGE]);

    const oldSchema = await columnsByRow(production.db, 'ontology_1_objects');

    const result = await restore(production, branch);

    expect(result).toEqual({
      code: 0,
      stdout: [JSON.stringify({ ontologyRid: RID, from: live(2), to: copy(2), copyVersion: 1, orphans: [] })],
      stderr: [],
    });

    expect(await row(production.db, RID)).toMatchObject({
      object_schema: NEW_OBJECTS,
      engine_schema: NEW_ENGINE,
      version: 2,
    });

    expect(await accounts(production.db, NEW_OBJECTS, 'account_id, name, stage')).toEqual([
      { account_id: 'acc-1', name: 'First', stage: 'lead' },
    ]);

    expect(await columnsByRow(production.db, 'ontology_1_objects')).toEqual(oldSchema);
  });

  it('service/storage#restore service/publish#upgrade ontology/object-edits/schema-migrations#the-schema-migrations-file: a copy that is 2 versions old runs the 2 steps that 2 publishes ran 1 at a time, and ends with the same tables and values', async () => {
    const { production, branch } = await installed();

    await publish(production.db, v2(), [PHASE_TO_STAGE]);

    await publish(production.db, v3());

    const published = {
      catalog: await catalog(production.db, 'ontology_1_objects'),
      rows: await columnsByRow(production.db, 'ontology_1_objects'),
    };

    const result = await restore(production, branch);

    expect(result).toEqual({
      code: 0,
      stdout: [JSON.stringify({ ontologyRid: RID, from: live(3), to: copy(3), copyVersion: 1, orphans: [] })],
      stderr: [],
    });

    expect(await row(production.db, RID)).toMatchObject({
      object_schema: NEW_OBJECTS,
      engine_schema: NEW_ENGINE,
      version: 3,
    });

    expect(await accounts(production.db, NEW_OBJECTS, 'account_id, name, stage, region')).toEqual([
      { account_id: 'acc-1', name: 'First', stage: 'lead', region: null },
    ]);

    expect({
      catalog: await catalog(production.db, NEW_OBJECTS),
      rows: await columnsByRow(production.db, NEW_OBJECTS),
    }).toEqual(published);
  });

  it('service/storage#restore: the switch of a copy that is 2 versions old runs each step 1 time, and each table change of a step on the copied schemas', async () => {
    const { production, branch } = await installed();

    await publish(production.db, v2(), [PHASE_TO_STAGE]);

    await publish(production.db, v3());

    const holder = await holdRowLock(production.url, RID);

    let stopped;

    try {
      stopped = await h.run(
        WRITE_P3,
        { lockTimeout: '1s' },
        { DATABASE_URL_DIRECT: production.url, RESTORE_SOURCE_URL: branch.url },
      );
    } finally {
      await holder.end();
    }

    expect(stopped.code).toBe(1);

    const { statements, db } = recording(production.db);

    expect(
      await restoreSwitch(db, {
        rid: RID,
        schemas: { object: NEW_OBJECTS, engine: NEW_ENGINE },
        source: { number: 1, version: 1, engineChangeCount: 3 },
      }),
    ).toMatchObject({
      to: { version: 3 },
    });

    expect(statements.map((statement) => statement.text).filter((text) => /^ALTER TABLE /i.test(text))).toEqual([
      `ALTER TABLE "${NEW_OBJECTS}"."account" RENAME COLUMN "phase" TO "stage"`,
      `ALTER TABLE "${NEW_OBJECTS}"."account" ADD COLUMN "region" text`,
    ]);

    expect(await row(production.db, RID)).toMatchObject({ object_schema: NEW_OBJECTS, version: 3 });
  });

  it('service/storage#restore: a step that fails on the copy exits 1 with the literal line and no stored value, and the row keeps its old schemas and its old version', async () => {
    const { production, branch } = await installed();

    await branch.db.query(sql(`UPDATE ontology_1_objects.account SET name = '${MARKER}', phase = NULL`));

    await publish(production.db, v2(), [PHASE_TO_STAGE]);

    await publish(production.db, v3StageRequired());

    const before = await row(production.db, RID);

    const result = await restore(production, branch);

    expect(result).toEqual({
      code: 1,
      stdout: [],
      stderr: [
        `The upgrade from version 1 failed at version 3 on "Make Property stage required of Object Type ${ACCOUNT}" with Default:InvalidArgument, so the row did not switch. ` +
          `The copy left the schemas ${NEW_OBJECTS} and ${NEW_ENGINE}.`,
      ],
    });

    expect(JSON.stringify(result)).not.toContain(MARKER);

    expect(before).toEqual({
      number: 1,
      object_schema: 'ontology_1_objects',
      engine_schema: 'ontology_1_engine',
      product: 'twin',
      version: 3,
      engine_change_count: 3,
    });

    expect(await row(production.db, RID)).toEqual(before);

    expect(await accounts(production.db, NEW_OBJECTS, 'account_id, name, phase')).toEqual([
      { account_id: 'acc-1', name: MARKER, phase: null },
    ]);
  });

  it('service/storage#restore: a fault of the database in the chain prints the fixed error line of the script, and the row does not switch', async () => {
    const { production, branch } = await installed();

    await publish(production.db, v2(), [PHASE_TO_STAGE]);

    const before = await row(production.db, RID);

    const holder = await holdRowLock(production.url, RID);

    const restoring = restore(production, branch);

    await waitForLockWaits(production.db, 1);

    const blocker = await holdTableLock(production.url, `${NEW_OBJECTS}.account`);

    await holder.end();

    await waitForLockWaits(production.db, 1);

    await h.asAdminIn(
      production.url,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );

    await blocker.end();

    expect(await restoring).toEqual({
      code: 1,
      stdout: [],
      stderr: [
        `The command failed with the error code 57P01. The row did not switch. The copy left the schemas ${NEW_OBJECTS} and ${NEW_ENGINE}.`,
      ],
    });

    expect(await row(production.db, RID)).toEqual(before);
  });

  it('service/storage#restore: the server ends the session while the switch is idle between 2 statements of its chain, and the row does not switch', async () => {
    const { production, branch } = await installed();

    await publish(production.db, v2(), [PHASE_TO_STAGE]);

    await publish(production.db, v3());

    const before = await row(production.db, RID);

    const { hostname, port } = new URL(production.url);
    const marker = 'RENAME COLUMN "phase" TO "stage"';
    let fired = false;

    const server = net.createServer((client) => {
      const upstream = net.connect(Number(port), hostname);
      let pid = 0;
      let armed = false;
      let held: Buffer | undefined;
      let pending = Buffer.alloc(0);

      client.on('data', (chunk: Buffer) => {
        if (!fired && chunk.includes(marker)) armed = true;

        upstream.write(chunk);
      });

      upstream.on('data', (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);

        while (pending.length >= 5) {
          const size = 1 + pending.readInt32BE(1);

          if (pending.length < size) return;

          const message = pending.subarray(0, size);

          pending = pending.subarray(size);

          if (message[0] === 0x4b) pid = message.readInt32BE(5);

          if (held && message[0] === 0x45) {
            client.write(Buffer.concat([held, message]));

            held = undefined;

            continue;
          }

          if (armed && !fired && message[0] === 0x5a) {
            fired = true;

            held = Buffer.from(message);

            void h.asAdminIn(production.url, `SELECT pg_terminate_backend(${pid})`);

            continue;
          }

          client.write(message);
        }
      });

      for (const [from, to] of [
        [client, upstream],
        [upstream, client],
      ] as const) {
        from.on('error', () => to.destroy());

        from.on('close', () => setTimeout(() => to.destroy(), 50));
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = new URL(production.url);

    address.hostname = '127.0.0.1';
    address.port = String((server.address() as net.AddressInfo).port);

    try {
      const result = await h.run(
        WRITE_P3,
        {},
        { DATABASE_URL_DIRECT: address.toString(), RESTORE_SOURCE_URL: branch.url },
      );

      expect(fired).toBe(true);

      expect(result).toEqual({
        code: 1,
        stdout: [],
        stderr: [
          `The command failed with the error code 57P01. The row did not switch. The copy left the schemas ${NEW_OBJECTS} and ${NEW_ENGINE}.`,
        ],
      });

      expect(await row(production.db, RID)).toEqual(before);
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  });

  it('service/storage#restore: a publish that starts during a switch gets 409 PublishLockTimeout after its lock wait, and the switch then ends on the newest version', async () => {
    const { production, branch } = await installed();

    await publish(production.db, v2(), [PHASE_TO_STAGE]);

    const holder = await holdRowLock(production.url, RID);

    const restoring = restore(production, branch);

    await waitForLockWaits(production.db, 1);

    const blocker = await holdTableLock(production.url, `${NEW_OBJECTS}.account`);

    await holder.end();

    await waitForLockWaits(production.db, 1);

    let publishing;

    try {
      publishing = await publish(production.db, v3()).then(
        () => 'stored',
        (error: unknown) => error,
      );
    } finally {
      await blocker.end();
    }

    expect(publishing).toMatchObject({ status: 409, errorName: 'PublishLockTimeout' });

    expect((await restoring).stdout).toEqual([
      JSON.stringify({ ontologyRid: RID, from: live(2), to: copy(2), copyVersion: 1, orphans: [] }),
    ]);

    expect(await row(production.db, RID)).toMatchObject({ object_schema: NEW_OBJECTS, version: 2 });
  });

  it('service/storage#restore: a publish that waits for the row lock of the switch runs its step on the new schemas, and the old schemas stay as they were', async () => {
    const { production, branch } = await installed();

    await publish(production.db, v2(), [PHASE_TO_STAGE]);

    const oldSchema = await columnsByRow(production.db, 'ontology_1_objects');

    const holder = await holdRowLock(production.url, RID);

    const restoring = restore(production, branch);

    await waitForLockWaits(production.db, 1);

    const blocker = await holdTableLock(production.url, `${NEW_OBJECTS}.account`);

    await holder.end();

    await waitForLockWaits(production.db, 1);

    let publishing;

    try {
      publishing = publish(production.db, v3());

      await waitForLockWaits(production.db, 2);
    } finally {
      await blocker.end();
    }

    expect(await publishing).toMatchObject({ version: 3 });

    expect((await restoring).code).toBe(0);

    expect(await row(production.db, RID)).toMatchObject({ object_schema: NEW_OBJECTS, version: 3 });

    expect(await accounts(production.db, NEW_OBJECTS, 'account_id, name, stage, region')).toEqual([
      { account_id: 'acc-1', name: 'First', stage: 'lead', region: null },
    ]);

    expect(await columnsByRow(production.db, 'ontology_1_objects')).toEqual(oldSchema);
  });

  it('service/storage#restore: a switch that starts during the transaction of a publish waits for it, then upgrades the copy to the version that the publish stored', async () => {
    const { production, branch } = await installed();

    const blocker = await holdTableLock(production.url, 'ontology_1_objects.account');

    let publishing;
    let restoring;

    try {
      publishing = publish(production.db, v2(), [PHASE_TO_STAGE]);

      await waitForLockWaits(production.db, 1);

      restoring = restore(production, branch);

      await waitForLockWaits(production.db, 2);
    } finally {
      await blocker.end();
    }

    expect(await publishing).toMatchObject({ version: 2 });

    expect(await restoring).toEqual({
      code: 0,
      stdout: [JSON.stringify({ ontologyRid: RID, from: live(2), to: copy(2), copyVersion: 1, orphans: [] })],
      stderr: [],
    });

    expect(await accounts(production.db, NEW_OBJECTS, 'account_id, name, stage')).toEqual([
      { account_id: 'acc-1', name: 'First', stage: 'lead' },
    ]);
  });

  it('service/publish#upgrade: the publish transaction sets its own limits before its first lock, and its chain runs no set_config', async () => {
    const { production } = await installed();

    const { statements, db } = recording(production.db);

    await publish(db, v2(), [PHASE_TO_STAGE]);

    const texts = statements.map((statement) => statement.text);
    const versionsLock = texts.findIndex((text) => /^LOCK TABLE ontology_registry\.product_versions /i.test(text));
    const limits = texts.flatMap((text, at) => (/set_config/i.test(text) ? [at] : []));

    expect(texts.filter((text) => /set_config/i.test(text))).toEqual([
      "SELECT set_config('lock_timeout', $1, true), set_config('transaction_timeout', $2, true)",
    ]);

    expect(limits.every((at) => at < versionsLock)).toBe(true);
    expect(texts.some((text) => /^ALTER TABLE \S*ontology_1_objects\S*\.\S*account/i.test(text))).toBe(true);
  });
});
