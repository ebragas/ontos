import type { OntologyIr } from '@osdk/client.unstable';
import type { Sql } from '../db/index.ts';
import type { Db } from '../db/promise.test-utils.ts';
import { handle, type HandleInput } from '../handler/index.ts';
import type { PublishedFunctions } from '../publish/index.ts';

import { convertOrThrow, grantsOf, ONTOLOGY_RID, stored } from '../ontology/stored.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import { emptyDb, type Answer } from '../service.test-utils.ts';
import { createTestIssuer, ORGANIZATION } from '../tokens.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';
import { ACTIONS_SETTINGS } from './actions.test-utils.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';

export interface RegistryDb {
  readonly db: Db;
  readonly unexpected: string[];
  clear(): void;
}

export interface StubActions extends Omit<RegistryDb, 'db'> {
  apply(actionType: string, body: unknown): Promise<Answer>;
}

const PRODUCT = 'twin';
const VERSION = 1;

export function registryDb(ir: OntologyIr, functions?: PublishedFunctions, database = 'stub'): RegistryDb {
  const grants = grantsOf(ir);
  const osdkSet = stored(ir).osdkSet;

  const installation = {
    rid: ONTOLOGY_RID,
    api_name: PRODUCT,
    display_name: PRODUCT,
    object_schema: 'ontology_1_objects',
    engine_schema: 'ontology_1_engine',
    product: PRODUCT,
    version: VERSION,
    database,
  };

  const version = {
    ir,
    metadata: convertOrThrow(
      { ir, osdkSet, ...(functions ? { functions } : {}), validateOnly: false },
      ONTOLOGY_RID,
      VERSION,
    ).metadata,
    osdk_set: osdkSet,
    functions: functions ?? null,
    grants,
  };

  const unexpected: string[] = [];

  const refuse = (what: string): Error => {
    unexpected.push(what);

    return new Error(`The stub database expected no ${what}.`);
  };

  const rowsOf = ({ text, values }: Sql): object[] | undefined => {
    if (text.includes('FROM ontology_registry.ontologies WHERE rid = $1 AND organization = $2')) {
      return values[0] === ONTOLOGY_RID && values[1] === ORGANIZATION ? [installation] : [];
    }

    if (text.includes('FROM ontology_registry.product_versions WHERE product = $1 AND version = $2')) {
      return values[0] === PRODUCT && values[1] === VERSION ? [version] : [];
    }

    return undefined;
  };

  const db: Db = {
    query: <Row extends object>(statement: Sql) => {
      const rows = rowsOf(statement);

      return rows ? Promise.resolve(rows as Row[]) : Promise.reject(refuse(`query: ${statement.text}`));
    },
    stream: (statement) => {
      const failure = refuse(`stream: ${statement.text}`);

      return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(failure) }) };
    },
    transaction: () => Promise.reject(refuse('transaction')),
    snapshot: () => Promise.reject(refuse('snapshot')),
  };

  return { db, unexpected, clear: () => void unexpected.splice(0) };
}

export async function stubActions(ir: OntologyIr, functions?: PublishedFunctions): Promise<StubActions> {
  const registry = registryDb(ir, functions);
  const { db, unexpected } = registry;
  const clear = () => registry.clear();

  const issuer = await createTestIssuer(ACTIONS_SETTINGS.auth);

  const input: HandleInput = {
    db: fallibleOf(db),
    directDb: fallibleOf(emptyDb),
    settings: ACTIONS_SETTINGS,
    keys: issuer.keys,
    users: roleUsers(grantsOf(ir).defaultRoles),
    workos: stubPublish(),
  };

  return {
    apply: async (actionType, body) => {
      const request = new Request(`http://localhost/api/v2/ontologies/${ONTOLOGY_RID}/actions/${actionType}/apply`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await issuer.workos()}`, 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

      const response = await handle(request, input);

      const text = await response.text();

      return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
    },
    unexpected,
    clear,
  };
}
