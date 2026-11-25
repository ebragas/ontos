import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import type { OrganizationId } from '../auth/index.ts';
import type { Db, DbFailure, Schemas } from '../db/index.ts';
import {
  ApiError,
  caught,
  outsideFailure,
  settle,
  type AsyncFallible,
  type Fault,
  type Result,
} from '../errors/index.ts';
import type { OrganizationCaller, OrganizationCtx, RouteInput } from '../handler/index.ts';
import type { OsdkSet } from '../publish/index.ts';
import { forPermissions } from './access/forPermissions.ts';
import { permissionCatalog, type CatalogEntry } from './access/permissionCatalog.ts';
import { permissionIndex, type PermissionIndex } from './access/permissionIndex.ts';
import { attributesRead, resolvePersonAttributes } from './access/personAttributes.ts';
import { ontologyEntry, REGISTRY_SCHEMA, type RegistryRow } from './access/registry.ts';
import { compileOntology } from './compile.ts';
import type {
  CompiledOntology,
  CompiledPersonAttribute,
  PersonAttributeName,
  StoredFunctions,
  StoredOntologyVersion,
} from './compiled/index.ts';
import { CompileError, sameOsdkSet } from './compiled/stored.ts';
import { parseGrantsFile, SERVICE_PERMISSIONS, type PermissionSlug } from './grantsFile.ts';
import { readOsdkSets } from './index.ts';

export interface OntologyView {
  readonly rid: string;
  readonly schemas: Schemas;
  readonly ontology: CompiledOntology;
  readonly personAttributes: readonly CompiledPersonAttribute[];
  readonly effectivePermissions: readonly PermissionSlug[];
}

interface LoadedVersion {
  readonly compiled: CompiledOntology;
  readonly index: PermissionIndex | null;
  readonly attributes: ReadonlyMap<PersonAttributeName, CompiledPersonAttribute>;
  readonly catalog: readonly CatalogEntry[];
  readonly allPermissions: readonly PermissionSlug[];
}

interface InstallationRow extends RegistryRow {
  readonly object_schema: string;
  readonly engine_schema: string;
  readonly product: string;
  readonly version: number;
  readonly database: string;
}

type ViewFailure = ApiError | DbFailure | Fault;

export type CompileRun = <T>(
  version: number,
  run: () => AsyncFallible<T, ViewFailure>,
) => AsyncFallible<T, ViewFailure>;

const plainCompile: CompileRun = (_version, run) => run();

const MAX_COMPILED_VERSIONS = 32;

const compiledVersions = new Map<string, LoadedVersion>();

function readCompiledVersion(key: string): LoadedVersion | undefined {
  const kept = compiledVersions.get(key);

  if (!kept) return undefined;

  compiledVersions.delete(key);

  compiledVersions.set(key, kept);

  return kept;
}

function keepCompiledVersion(key: string, value: LoadedVersion): void {
  compiledVersions.delete(key);

  if (compiledVersions.size >= MAX_COMPILED_VERSIONS) {
    const oldest = compiledVersions.keys().next().value;

    if (oldest !== undefined) compiledVersions.delete(oldest);
  }

  compiledVersions.set(key, value);
}

type Flights<T> = WeakMap<Db, Map<string, Promise<Result<T, ViewFailure>>>>;

const installationFlights: Flights<InstallationRow> = new WeakMap();
const loadingVersions: Flights<LoadedVersion> = new WeakMap();

async function* coalesce<T>(
  flights: Flights<T>,
  db: Db,
  key: string,
  run: () => AsyncFallible<T, ViewFailure>,
): AsyncFallible<T, ViewFailure> {
  const existing = flights.get(db);
  const map = existing ?? new Map<string, Promise<Result<T, ViewFailure>>>();

  if (!existing) flights.set(db, map);

  let flight = map.get(key);

  if (!flight) {
    flight = settle(run()).finally(() => {
      if (map.get(key) === flight) map.delete(key);
    });

    map.set(key, flight);
  }

  const waited = await caught(() => flight);

  if (!waited.ok) return yield outsideFailure(waited.error);

  if (!waited.value.ok) return yield waited.value.error;

  return waited.value.value;
}

export async function* openOntology(
  db: Db,
  rid: string,
  caller: OrganizationCaller,
  compile: CompileRun = plainCompile,
): AsyncFallible<OntologyView, ViewFailure> {
  const row = yield* installation(db, rid, caller.organization);
  const loaded = yield* loadProductVersion(db, row, compile);

  const effectivePermissions = caller.permissions.includes('*')
    ? [...new Set([...caller.permissions, ...loaded.allPermissions])]
    : caller.permissions;

  const { view, personAttributes } = permissionView(loaded, new Set(effectivePermissions));
  const ontology: CompiledOntology = { ...view, metadata: { ...view.metadata, ontology: ontologyEntry(row) } };

  return {
    rid,
    schemas: { object: row.object_schema, engine: row.engine_schema },
    ontology,
    personAttributes,
    effectivePermissions,
  };
}

function permissionView(loaded: LoadedVersion, permissions: ReadonlySet<PermissionSlug>) {
  const view = forPermissions(loaded.compiled, loaded.index, permissions);
  const personAttributes = [...attributesRead(view)].sort().flatMap((name) => loaded.attributes.get(name) ?? []);

  return { view, personAttributes };
}

export async function* getPermissionCatalog(
  input: RouteInput,
  ctx: OrganizationCtx,
): AsyncFallible<Response, ViewFailure> {
  const row = yield* installation(ctx.db, input.params['ontologyRid'] ?? '', ctx.caller.organization);
  const { catalog } = yield* loadProductVersion(ctx.db, row, ctx.compile ?? plainCompile);

  return Response.json({ data: catalog });
}

async function* installation(
  db: Db,
  rid: string,
  organization: OrganizationId,
): AsyncFallible<InstallationRow, ViewFailure> {
  return yield* coalesce(
    installationFlights,
    db,
    JSON.stringify([rid, organization]),
    async function* (): AsyncFallible<InstallationRow, ViewFailure> {
      const [row] = yield* db.query<InstallationRow>({
        text: `SELECT rid, api_name, display_name, object_schema, engine_schema, product, version, current_database() AS database FROM ${REGISTRY_SCHEMA}.ontologies WHERE rid = $1 AND organization = $2`,
        values: [rid, organization],
      });

      if (!row) return yield new ApiError(404, 'OntologyNotFound', { ontologyRid: rid });

      return row;
    },
  );
}

export interface WarmCandidate {
  readonly ontologyRid: string;
  readonly bundle: string;
}

export async function* checkOntologyVersions(
  db: Db,
  compile: CompileRun = plainCompile,
  onWarm?: (candidate: WarmCandidate) => void,
): AsyncFallible<void, ViewFailure> {
  const rows = yield* db.query<ProductVersion & { readonly rid: string | null }>({
    text: `SELECT current_database() AS database, v.product, max(v.version) AS version,
             (SELECT o.rid FROM ${REGISTRY_SCHEMA}.ontologies o WHERE o.product = v.product AND o.version = max(v.version) ORDER BY o.number LIMIT 1) AS rid
           FROM ${REGISTRY_SCHEMA}.product_versions v
           WHERE v.product IN (SELECT o.product FROM ${REGISTRY_SCHEMA}.ontologies o) GROUP BY v.product ORDER BY v.product`,
    values: [],
  });

  let candidate: WarmCandidate | undefined;

  for (const row of rows) {
    const loaded = yield* loadProductVersion(db, row, compile);

    if (candidate === undefined && row.rid !== null && loaded.compiled.functionBundle !== undefined) {
      candidate = { ontologyRid: row.rid, bundle: loaded.compiled.functionBundle };
    }
  }

  if (candidate !== undefined) onWarm?.(candidate);
}

interface ProductVersion {
  readonly database: string;
  readonly product: string;
  readonly version: number;
}

async function* loadProductVersion(
  db: Db,
  { database, product, version }: ProductVersion,
  compile: CompileRun,
): AsyncFallible<LoadedVersion, ViewFailure> {
  const key = JSON.stringify([database, product, version]);
  const kept = readCompiledVersion(key);

  if (kept) return kept;

  return yield* coalesce(loadingVersions, db, key, async function* (): AsyncFallible<LoadedVersion, ViewFailure> {
    const again = readCompiledVersion(key);

    if (again) return again;

    const value = yield* compile(version, () => compileProductVersion(db, product, version));

    keepCompiledVersion(key, value);

    return value;
  });
}

async function* compileProductVersion(
  db: Db,
  product: string,
  version: number,
): AsyncFallible<LoadedVersion, ViewFailure> {
  const [row] = yield* db.query<{
    ir: unknown;
    metadata: OntologyFullMetadata;
    osdk_set: OsdkSet;
    functions: StoredFunctions | null;
    grants: unknown;
  }>({
    text: `SELECT ir, metadata, osdk_set, functions, grants FROM ${REGISTRY_SCHEMA}.product_versions WHERE product = $1 AND version = $2`,
    values: [product, version],
  });

  if (!row) return yield outsideFailure(new CompileError(`Version ${version} of product ${product} is not stored.`));

  const stored: Omit<StoredOntologyVersion, 'grants'> = {
    version,
    ir: row.ir,
    metadata: row.metadata,
    osdkSet: row.osdk_set,
    ...(row.functions ? { functions: row.functions } : {}),
  };

  const notSupported = (cause: unknown) =>
    Object.assign(new ApiError(503, 'OntologyService:OntologyVersionNotSupported'), { cause });

  const isListed = readOsdkSets().some((entry) => sameOsdkSet(entry.packages, stored.osdkSet));

  if (!isListed)
    return yield notSupported(
      new Error(`This release does not list the OSDK set of version ${version} of product ${product}.`),
    );

  const parsed = parseGrantsFile(row.grants);
  const grants = 'grants' in parsed ? parsed.grants : null;
  const compiled = caught(() => settle(compileOntology(stored)));

  if (!compiled.ok) return yield outsideFailure(compiled.error);

  if (!compiled.value.ok) return yield notSupported(compiled.value.error);

  const ontology = compiled.value.value;
  const index = grants && permissionIndex(ontology, grants);

  const allPermissions = grants
    ? [...new Set([...Object.keys(grants.permissions), ...SERVICE_PERMISSIONS])].sort()
    : [...SERVICE_PERMISSIONS];

  return {
    compiled: ontology,
    index,
    attributes: resolvePersonAttributes(ontology, grants),
    catalog: grants && index ? permissionCatalog(grants, index) : [],
    allPermissions,
  };
}
