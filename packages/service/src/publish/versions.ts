import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import { REGISTRY_SCHEMA, type Db, type DbFailure } from '../db/index.ts';
import { ApiError, type AsyncFallible } from '../errors/index.ts';
import type { CompiledOntology, StoredOntologyVersion } from '../ontology/index.ts';
import { extractedNameKeys, LINK_ID_PREFIX } from './pure/storedNames.ts';

export const PRODUCT_VERSIONS = `${REGISTRY_SCHEMA}.product_versions`;

export async function* refuseOtherProduct(db: Db, product: string): AsyncFallible<void, ApiError | DbFailure> {
  const [other] = yield* db.query<{ product: string }>({
    text: `SELECT product FROM ${PRODUCT_VERSIONS} WHERE product <> $1 LIMIT 1`,
    values: [product],
  });

  if (other) return yield new ApiError(400, 'Default:InvalidArgument', { part: 'product' });
}

export async function* readNewestNumber(db: Db, product: string): AsyncFallible<number, DbFailure> {
  const [newest] = yield* db.query<{ version: number }>({
    text: `SELECT coalesce(max(version), 0)::int AS version FROM ${PRODUCT_VERSIONS} WHERE product = $1`,
    values: [product],
  });

  return newest?.version ?? 0;
}

export async function* readNewestVersion(
  db: Db,
  product: string,
): AsyncFallible<StoredOntologyVersion | undefined, DbFailure> {
  const [row] = yield* db.query<{
    version: number;
    ir: StoredOntologyVersion['ir'];
    metadata: OntologyFullMetadata;
    osdk_set: StoredOntologyVersion['osdkSet'];
    functions: StoredOntologyVersion['functions'] | null;
    grants: StoredOntologyVersion['grants'];
  }>({
    text: `SELECT version, ir, metadata, osdk_set, functions, grants FROM ${PRODUCT_VERSIONS} WHERE product = $1 ORDER BY version DESC LIMIT 1`,
    values: [product],
  });

  if (!row) return undefined;

  return {
    version: row.version,
    ir: row.ir,
    metadata: row.metadata,
    osdkSet: row.osdk_set,
    ...(row.functions ? { functions: row.functions } : {}),
    grants: row.grants,
  };
}

interface ApiName {
  readonly key: string;
  readonly apiName: string;
  readonly change: string;
}

function apiNames(ontology: CompiledOntology): ApiName[] {
  const names: ApiName[] = [];

  for (const [type, objectType] of ontology.objectTypes) {
    names.push({ key: `objectType:${type}`, apiName: type, change: `Create Object Type ${type}` });

    for (const property of [...objectType.properties.keys(), ...objectType.derived.keys()]) {
      names.push({
        key: `property:${type}:${property}`,
        apiName: property,
        change: `Create Property ${property} of Object Type ${type}`,
      });
    }
  }

  for (const link of ontology.linkTypes.keys()) {
    names.push({ key: `linkType:${link}`, apiName: link, change: `Create Link Type ${link}` });
  }

  for (const [type, objectType] of ontology.objectTypes) {
    for (const [side, link] of objectType.links) {
      names.push({ key: `link:${type}:${side}`, apiName: side, change: `Create Link Type ${link.linkType}` });
    }
  }

  for (const action of ontology.actionTypes.keys()) {
    names.push({ key: `actionType:${action}`, apiName: action, change: `Create Action Type ${action}` });
  }

  return names;
}

const VERSION_NAMES_SQL = `SELECT
  v.version,
  ARRAY(
    SELECT 'objectType:' || (ot.val->'objectType'->>'apiName')
    FROM jsonb_each(
      CASE WHEN jsonb_typeof(v.ir->'ontology'->'objectTypes') = 'object'
        THEN v.ir->'ontology'->'objectTypes'
        ELSE '{}'::jsonb
      END
    ) AS ot(k, val)
    WHERE jsonb_typeof(ot.val->'objectType'->'apiName') = 'string'
      AND (ot.val->'objectType'->>'apiName') <> ''
    UNION ALL
    SELECT 'property:' || (ot.val->'objectType'->>'apiName') || ':' || (pt.val->>'apiName')
    FROM jsonb_each(
      CASE WHEN jsonb_typeof(v.ir->'ontology'->'objectTypes') = 'object'
        THEN v.ir->'ontology'->'objectTypes'
        ELSE '{}'::jsonb
      END
    ) AS ot(k, val),
    LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(ot.val->'objectType'->'propertyTypes') = 'object'
        THEN ot.val->'objectType'->'propertyTypes'
        ELSE '{}'::jsonb
      END
    ) AS pt(pk, val)
    WHERE jsonb_typeof(ot.val->'objectType'->'apiName') = 'string'
      AND (ot.val->'objectType'->>'apiName') <> ''
      AND jsonb_typeof(pt.val->'apiName') = 'string'
      AND (pt.val->>'apiName') <> ''
    UNION ALL
    SELECT '${LINK_ID_PREFIX}' || (lt.val->'linkType'->>'id')
    FROM jsonb_each(
      CASE WHEN jsonb_typeof(v.ir->'ontology'->'linkTypes') = 'object'
        THEN v.ir->'ontology'->'linkTypes'
        ELSE '{}'::jsonb
      END
    ) AS lt(k, val)
    WHERE jsonb_typeof(lt.val->'linkType'->'id') = 'string'
      AND (lt.val->'linkType'->>'id') <> ''
    UNION ALL
    SELECT 'link:' || (side.on_type #>> '{}') || ':' || (side.meta->>'apiName')
    FROM jsonb_each(
      CASE WHEN jsonb_typeof(v.ir->'ontology'->'linkTypes') = 'object'
        THEN v.ir->'ontology'->'linkTypes'
        ELSE '{}'::jsonb
      END
    ) AS lt(k, val),
    LATERAL (
      VALUES
        (lt.val->'linkType'->'definition'->'oneToMany'->'objectTypeRidOneSide',
         lt.val->'linkType'->'definition'->'oneToMany'->'oneToManyLinkMetadata'),
        (lt.val->'linkType'->'definition'->'oneToMany'->'objectTypeRidManySide',
         lt.val->'linkType'->'definition'->'oneToMany'->'manyToOneLinkMetadata'),
        (lt.val->'linkType'->'definition'->'manyToMany'->'objectTypeRidA',
         lt.val->'linkType'->'definition'->'manyToMany'->'objectTypeAToBLinkMetadata'),
        (lt.val->'linkType'->'definition'->'manyToMany'->'objectTypeRidB',
         lt.val->'linkType'->'definition'->'manyToMany'->'objectTypeBToALinkMetadata')
    ) AS side(on_type, meta)
    WHERE jsonb_typeof(side.on_type) = 'string'
      AND (side.on_type #>> '{}') <> ''
      AND jsonb_typeof(side.meta->'apiName') = 'string'
      AND (side.meta->>'apiName') <> ''
    UNION ALL
    SELECT 'actionType:' || (at.val->'actionType'->'metadata'->>'apiName')
    FROM jsonb_each(
      CASE WHEN jsonb_typeof(v.ir->'ontology'->'actionTypes') = 'object'
        THEN v.ir->'ontology'->'actionTypes'
        ELSE '{}'::jsonb
      END
    ) AS at(k, val)
    WHERE jsonb_typeof(at.val->'actionType'->'metadata'->'apiName') = 'string'
      AND (at.val->'actionType'->'metadata'->>'apiName') <> ''
  ) AS names
FROM ${PRODUCT_VERSIONS} v
WHERE v.product = $1
ORDER BY v.version`;

export async function* readVersionNameKeys(
  db: Db,
  product: string,
): AsyncFallible<readonly { readonly version: number; readonly keys: ReadonlySet<string> }[], DbFailure> {
  const rows = yield* db.query<{ version: number; names: string[] }>({
    text: VERSION_NAMES_SQL,
    values: [product],
  });

  return rows.map((row) => ({ version: row.version, keys: extractedNameKeys(row.names) }));
}

export async function* checkReservedNames(
  db: Db,
  product: string,
  ontology: CompiledOntology,
): AsyncFallible<void, ApiError | DbFailure> {
  const deletedIn = new Map<string, number>();
  let previous: ReadonlySet<string> = new Set<string>();

  for (const version of yield* readVersionNameKeys(db, product)) {
    for (const key of previous) if (!version.keys.has(key)) deletedIn.set(key, version.version);

    previous = version.keys;
  }

  for (const name of apiNames(ontology)) {
    const version = deletedIn.get(name.key);

    if (version !== undefined) {
      return yield new ApiError(400, 'Default:InvalidArgument', {
        change: name.change,
        reservedApiName: name.apiName,
        deletedInVersion: version,
      });
    }
  }
}
