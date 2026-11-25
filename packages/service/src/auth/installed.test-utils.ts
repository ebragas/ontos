import { handle, type HandleInput, type Settings } from '../handler/index.ts';
import type { OntologyIr } from '@osdk/client.unstable';
import type { GrantsFile } from '../ontology/index.ts';
import { installOnce } from '../install.test-utils.ts';
import { stored, twinFunctions, twinIr, unchecked } from '../ontology/stored.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import { startPostgres } from '../postgres.test-utils.ts';
import { newDatabase } from '../publish/publish.test-utils.ts';
import type { TestIssuer } from '../tokens.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';

export const ACCOUNT = 'com.example.twin.Account';
export const CREATE_ACCOUNT = 'com.example.twin.create-account';

export const LOAD_ACCOUNTS = { objectSet: { type: 'base', objectType: ACCOUNT }, pageSize: 1 };

export interface Installed {
  readonly db: HandleInput['db'];
  stop(): Promise<void>;
}

function grantsWith(permission: string): GrantsFile {
  const { objectTypes, actionTypes } = twinIr('0.4.0').ontology;
  const each = (names: object) => Object.fromEntries(Object.keys(names).map((name) => [name, permission]));

  return {
    permissions: { [permission]: { description: permission } },
    objectTypes: each(objectTypes),
    actionTypes: each(actionTypes ?? {}),
    defaultRoles: { admin: ['ontology:install', permission], member: [permission] },
  };
}

function installedIr(): OntologyIr {
  const ir = twinIr('0.4.0');
  const block = ir.ontology.objectTypes[ACCOUNT];

  if (!block) throw new Error(`Twin 0.4.0 has no ${ACCOUNT}.`);

  block.entityMetadata = unchecked({
    ...block.entityMetadata,
    editsHistory: { type: 'config', config: { store: ACCOUNT, storeAllPreviousProperties: true } },
  });

  return ir;
}

export function publishBody(permission: string, validateOnly = false): object {
  const ir = installedIr();

  return {
    ir,
    functions: twinFunctions('0.4.0'),
    product: 'twin',
    schemaMigrations: { migrations: [] },
    osdkSet: stored(ir).osdkSet,
    grants: grantsWith(permission),
    validateOnly,
  };
}

export async function startInstalled(settings: Settings, issuer: TestIssuer, permission: string): Promise<Installed> {
  const postgres = await startPostgres();

  const database = await newDatabase(postgres.url);

  const input: HandleInput = {
    db: fallibleOf(database.db),
    directDb: fallibleOf(database.db),
    settings,
    keys: issuer.keys,
    users: roleUsers({}),
    workos: stubPublish(),
  };

  const response = await handle(
    new Request('http://localhost/api/ontology-service/v1/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${await issuer.github()}`, 'content-type': 'application/json' },
      body: JSON.stringify(publishBody(permission)),
    }),
    input,
  );

  const text = await response.text();

  if (response.status !== 200) throw new Error(`The publish gave ${response.status}: ${text}`);

  await installOnce(database.db, settings.productRid, 'twin');

  return {
    db: fallibleOf(database.db),
    stop: async () => {
      await database.end();

      await postgres.stop();
    },
  };
}
