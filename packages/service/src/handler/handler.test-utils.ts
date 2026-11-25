import type { OntologyIr } from '@osdk/client.unstable';
import { handle, type HandleInput, type Settings } from './index.ts';
import { installOnce } from '../install.test-utils.ts';
import { settingsOf } from '../metadata.test-utils.ts';
import type { PublishedFunctions } from '../publish/index.ts';
import { grantsOf, ONTOLOGY_RID, stored, twinFunctions, twinIr } from '../ontology/stored.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import { startPostgres } from '../postgres.test-utils.ts';
import { newDatabase } from '../publish/publish.test-utils.ts';
import { createTestIssuer, type TestIssuer } from '../tokens.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';

export { ONTOLOGY_RID };

export interface InstalledOntology {
  readonly input: HandleInput;
  readonly url: string;
  readonly settings: Settings;
  readonly issuer: TestIssuer;
  stop(): Promise<void>;
}

export function publishBody(
  validateOnly: boolean,
  ir: OntologyIr = twinIr('0.4.0'),
  functions: PublishedFunctions = twinFunctions('0.4.0'),
): object {
  return {
    ir,
    functions,
    product: 'twin',
    schemaMigrations: { migrations: [] },
    osdkSet: stored(ir).osdkSet,
    grants: grantsOf(ir),
    validateOnly,
  };
}

export async function startInstalled(
  ir: OntologyIr = twinIr('0.4.0'),
  functions: PublishedFunctions = twinFunctions('0.4.0'),
): Promise<InstalledOntology> {
  const settings = settingsOf('test');

  const postgres = await startPostgres();

  const database = await newDatabase(postgres.url);

  const issuer = await createTestIssuer(settings.auth);

  const input: HandleInput = {
    db: fallibleOf(database.db),
    directDb: fallibleOf(database.db),
    settings,
    keys: issuer.keys,
    users: roleUsers(grantsOf(ir).defaultRoles),
    workos: stubPublish(),
  };

  const published = await handle(
    new Request('http://localhost/api/ontology-service/v1/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${await issuer.github()}` },
      body: JSON.stringify(publishBody(false, ir, functions)),
    }),
    input,
  );

  const text = await published.text();

  if (published.status !== 200) throw new Error(`The publish gave ${published.status}: ${text}`);

  await installOnce(database.db, ONTOLOGY_RID, 'twin');

  return {
    input,
    url: database.url,
    settings,
    issuer,
    stop: async () => {
      await database.end();

      await postgres.stop();
    },
  };
}
