import type {
  LinkTypeMetadata,
  OntologyIr,
  OntologyIrActionTypeBlockDataV2,
  OntologyIrLinkTypeBlockDataV2,
  OntologyIrObjectTypeBlockDataV2,
} from '@osdk/client.unstable';
import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import { handle, type HandleInput, type Settings } from './handler/index.ts';
import { type CompiledOntology, type GrantsFile } from './ontology/index.ts';
import type { PublishedFunctions } from './publish/index.ts';
import { toFullMetadata } from './publish/metadata.ts';
import {
  compileOrThrow,
  grantsOf,
  ONTOLOGY_RID,
  stored,
  twinFunctions,
  twinIr,
  type TwinVersion,
} from './ontology/stored.test-utils.ts';
import { startPostgres } from './postgres.test-utils.ts';
import { newDatabase } from './publish/publish.test-utils.ts';
import { installOnce } from './install.test-utils.ts';
import { type Answer } from './service.test-utils.ts';
import { roleUsers } from './people.test-utils.ts';
import { createTestIssuer } from './tokens.test-utils.ts';
import { stubPublish } from './workos.test-utils.ts';
import { fallibleOf } from './db/promise.test-utils.ts';

export { ONTOLOGY_RID };

export const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const UUID_V5 = '[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

export interface Converted {
  readonly compiled: CompiledOntology;
  readonly metadata: OntologyFullMetadata;
}

export function convert(ir: OntologyIr, options: { functions?: PublishedFunctions; version?: number } = {}): Converted {
  const compiled = compileOrThrow(stored(ir, options));

  return { compiled, metadata: toFullMetadata(compiled) };
}

export function convertTwin(version: TwinVersion): Converted {
  return convert(twinIr(version), { functions: twinFunctions(version) });
}

export function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export function irWith(parts: {
  objectTypes: readonly OntologyIrObjectTypeBlockDataV2[];
  linkTypes?: readonly OntologyIrLinkTypeBlockDataV2[];
  actionTypes?: readonly OntologyIrActionTypeBlockDataV2[];
}): OntologyIr {
  const twin = twinIr('0.4.0');

  return {
    ...twin,
    ontology: {
      ...twin.ontology,
      objectTypes: Object.fromEntries(parts.objectTypes.map((b) => [b.objectType.apiName, b])),
      linkTypes: Object.fromEntries((parts.linkTypes ?? []).map((b) => [b.linkType.id, b])),
      actionTypes: Object.fromEntries((parts.actionTypes ?? []).map((b) => [b.actionType.metadata.apiName, b])),
    },
  };
}

export function linkSide(apiName: string, displayName: string): LinkTypeMetadata {
  return {
    apiName,
    displayMetadata: { displayName, pluralDisplayName: `${displayName}s`, visibility: 'NORMAL', groupDisplayName: '' },
    typeClasses: [],
  };
}

export function manyToManyLink(options: {
  id: string;
  a: string;
  aKey: string;
  aSide: LinkTypeMetadata;
  b: string;
  bKey: string;
  bSide: LinkTypeMetadata;
}): OntologyIrLinkTypeBlockDataV2 {
  const { id, a, aKey, aSide, b, bKey, bSide } = options;

  return {
    linkType: {
      definition: {
        type: 'manyToMany',
        manyToMany: {
          objectTypeAToBLinkMetadata: aSide,
          objectTypeBToALinkMetadata: bSide,
          objectTypeRidA: a,
          objectTypeRidB: b,
          objectTypeAPrimaryKeyPropertyMapping: [
            { from: { apiName: aKey, object: a }, to: { apiName: aKey, object: a } },
          ],
          objectTypeBPrimaryKeyPropertyMapping: [
            { from: { apiName: bKey, object: b }, to: { apiName: bKey, object: b } },
          ],
        },
      },
      id,
      status: { type: 'active', active: {} },
      redacted: false,
    },
    datasources: [],
    entityMetadata: { arePatchesEnabled: true },
  };
}

export interface MetadataService {
  get(path: string): Promise<Answer>;
  publish(functions: PublishedFunctions): Promise<Answer>;
  stop(): Promise<void>;
}

const APP = { repository: 'example/twin', environment: 'publish' };

export function settingsOf(environment: string): Settings {
  return {
    productRid: ONTOLOGY_RID,
    environment,
    auth: { workosClientId: 'metadata', baseUrl: 'http://localhost', app: APP },
  };
}

export async function startMetadata(
  ir?: OntologyIr,
  functions?: PublishedFunctions,
  environment = 'test',
  grants: GrantsFile = grantsOf(ir ?? {}),
): Promise<MetadataService> {
  const settings = settingsOf(environment);

  const postgres = await startPostgres();

  const database = await newDatabase(postgres.url);

  const issuer = await createTestIssuer(settings.auth);

  const input: HandleInput = {
    db: fallibleOf(database.db),
    directDb: fallibleOf(database.db),
    settings,
    keys: issuer.keys,
    users: roleUsers(grants.defaultRoles),
    workos: stubPublish(),
  };

  const send = async (method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<Answer> => {
    const init: RequestInit = {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    };

    if (body !== undefined) init.body = JSON.stringify(body);

    const response = await handle(new Request(`http://localhost${path}`, init), input);

    const text = await response.text();

    return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
  };

  const publish = async (published?: PublishedFunctions): Promise<Answer> => {
    if (!ir) throw new Error('startMetadata got no IR to publish.');

    return send('POST', '/api/ontology-service/v1/publish', await issuer.github(), {
      ir,
      ...(published ? { functions: published } : {}),
      product: 'twin',
      schemaMigrations: { migrations: [] },
      osdkSet: stored(ir).osdkSet,
      grants,
      validateOnly: false,
    });
  };

  if (ir) {
    const published = await publish(functions);

    if (published.status !== 200)
      throw new Error(`The publish gave ${published.status}: ${JSON.stringify(published.body)}`);

    await installOnce(database.db, ONTOLOGY_RID, 'twin');
  }

  return {
    get: async (path) => send('GET', `/api/v2/ontologies/${ONTOLOGY_RID}/${path}`, await issuer.workos()),
    publish,
    stop: async () => {
      await database.end();

      await postgres.stop();
    },
  };
}
