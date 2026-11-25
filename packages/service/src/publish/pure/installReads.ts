import type { OntologyV2 } from '@osdk/foundry.ontologies';
import { REGISTRY_SCHEMA, type Db, type DbFailure } from '../../db/index.ts';
import { ApiError, caught, settle, type AsyncFallible, type Fallible, type Fault } from '../../errors/index.ts';
import type { OrganizationCtx, RouteInput } from '../../handler/index.ts';
import {
  compileOntology,
  isRecord,
  type CompiledOntology,
  type JsonValue,
  type StoredOntologyVersion,
} from '../../ontology/index.ts';
import { installIn } from '../install.ts';
import { PRODUCT_VERSIONS, readNewestVersion } from '../versions.ts';
import type { CheckScope, Installation, InstallInput, LockedInstallation, VersionsLock } from './installTypes.ts';

const ONTOLOGIES = `${REGISTRY_SCHEMA}.ontologies`;

interface InstallRequest {
  readonly product: string;
  readonly apiName: string;
  readonly displayName: string;
}

export async function* install(
  input: RouteInput,
  ctx: OrganizationCtx,
): AsyncFallible<Response, ApiError | DbFailure | Fault> {
  if (!ctx.caller.permissions.includes('ontology:install') && !ctx.caller.permissions.includes('*'))
    return yield new ApiError(403, 'Default:PermissionDenied');

  const request = yield* readInstallRequest(input.body);
  const rid = `ri.ontology.main.ontology.${crypto.randomUUID()}`;

  yield* ctx.db.transaction((tx) => installFrom(tx, { rid, ...request, organization: ctx.caller.organization }));

  return Response.json({
    rid,
    apiName: request.apiName,
    displayName: request.displayName,
    description: '',
  } satisfies OntologyV2);
}

const ONTOLOGY_API_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function* readInstallRequest(body: JsonValue | undefined): Fallible<InstallRequest, ApiError> {
  const value = isRecord(body) ? body : {};

  const field = (part: keyof InstallRequest): string | undefined => {
    const text = value[part];

    return typeof text !== 'string' || text === '' ? undefined : text;
  };

  const invalid = (part: keyof InstallRequest) => new ApiError(400, 'Default:InvalidArgument', { part });
  const apiName = field('apiName');

  if (apiName === undefined) return yield invalid('apiName');

  if (!ONTOLOGY_API_NAME.test(apiName)) return yield new ApiError(400, 'Default:InvalidArgument', { part: 'apiName' });

  const product = field('product');

  if (product === undefined) return yield invalid('product');

  const displayName = field('displayName');

  if (displayName === undefined) return yield invalid('displayName');

  return { product, apiName, displayName };
}

export async function* installFrom(
  tx: Db,
  input: InstallInput,
): AsyncFallible<Installation, ApiError | DbFailure | Fault> {
  const lock = yield* lockProductVersions(tx);
  const current = yield* readNewestVersion(tx, input.product);

  if (!current) return yield new ApiError(404, 'OntologyService:ProductNotFound', { product: input.product });

  const taken =
    (yield* tx.query({
      text: `SELECT 1 FROM ${ONTOLOGIES} WHERE organization = $1 AND api_name = $2`,
      values: [input.organization, input.apiName],
    })).length > 0;

  if (taken) return yield new ApiError(409, 'OntologyService:ApiNameAlreadyExists', { apiName: input.apiName });

  return yield* installIn(tx, lock, input, yield* compiledOrDefect(current));
}

export function* compiledOrDefect(stored: StoredOntologyVersion): Generator<Fault, CompiledOntology, never> {
  const ran = caught(() => settle(compileOntology(stored)));

  if (!ran.ok) return yield { kind: 'fault', error: ran.error };

  if (!ran.value.ok) return yield { kind: 'fault', error: ran.value.error };

  return ran.value.value;
}

export async function* lockProductVersions(tx: Db): AsyncFallible<VersionsLock, DbFailure> {
  yield* tx.query({ text: `LOCK TABLE ${PRODUCT_VERSIONS} IN EXCLUSIVE MODE`, values: [] });

  return {} as VersionsLock;
}

export async function* lockInstallation(tx: Db, rid: string): AsyncFallible<LockedInstallation | undefined, DbFailure> {
  const [row] = yield* tx.query<{
    number: number;
    api_name: string;
    product: string;
    object_schema: string;
    engine_schema: string;
    version: number;
  }>({
    text: `SELECT number, api_name, product, object_schema, engine_schema, version FROM ${ONTOLOGIES} WHERE rid = $1 FOR UPDATE`,
    values: [rid],
  });

  if (!row) return undefined;

  return {
    number: row.number,
    rid,
    apiName: row.api_name,
    product: row.product,
    schemas: { object: row.object_schema, engine: row.engine_schema },
    version: row.version,
  } as LockedInstallation;
}

function scopeFilter(scope: CheckScope, n: number): { readonly text: string; readonly value: string[] | null } {
  const value = scope === 'product' ? null : scope.organization === undefined ? [] : [scope.organization];

  return { text: `($${n}::text[] IS NULL OR o.organization = ANY($${n}::text[]))`, value };
}

export async function* readInstallations(
  db: Db,
  product: string,
  scope: CheckScope,
): AsyncFallible<Installation[], DbFailure> {
  const filter = scopeFilter(scope, 2);

  const rows = yield* db.query<{ rid: string; object_schema: string; engine_schema: string; version: number }>({
    text: `SELECT rid, object_schema, engine_schema, version FROM ${ONTOLOGIES} o WHERE product = $1 AND ${filter.text} ORDER BY number`,
    values: [product, filter.value],
  });

  return rows.map((row) => ({
    rid: row.rid,
    schemas: { object: row.object_schema, engine: row.engine_schema },
    version: row.version,
  }));
}
