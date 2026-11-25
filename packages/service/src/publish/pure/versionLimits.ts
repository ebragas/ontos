import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import { REGISTRY_SCHEMA } from '../../db/index.ts';
import { ApiError } from '../../errors/index.ts';
import type { StoredOntologyVersion } from '../../ontology/index.ts';
import type { CheckedRequest } from '../index.ts';

const PRODUCT_VERSIONS = `${REGISTRY_SCHEMA}.product_versions`;

export const STORE_LIMIT = { phase: 'version', table: PRODUCT_VERSIONS, changed: false } as const;

const LOCK_NOT_AVAILABLE = '55P03';
const DEADLOCK_DETECTED = '40P01';
const TRANSACTION_TIMEOUT = '25P04';
const QUERY_CANCELED = '57014';

export function limitKind(error: unknown): 'lock' | 'timeout' | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

  if (code === LOCK_NOT_AVAILABLE || code === DEADLOCK_DETECTED) return 'lock';

  if (code === TRANSACTION_TIMEOUT || code === QUERY_CANCELED) return 'timeout';

  return undefined;
}

export function publishLimitError(error: unknown): ApiError | undefined {
  const limit = limitKind(error);

  if (limit === 'lock') return new ApiError(409, 'PublishLockTimeout', STORE_LIMIT);

  if (limit === 'timeout') return new ApiError(400, 'PublishTimeExceededLimit', STORE_LIMIT);

  return undefined;
}

export function sameParts(
  current: StoredOntologyVersion,
  request: CheckedRequest,
  metadata: OntologyFullMetadata,
): boolean {
  return (
    sameJson(withoutLinkIds(current.ir), withoutLinkIds(request.ir)) &&
    sameJson(current.metadata, metadata) &&
    sameJson(current.osdkSet, request.osdkSet) &&
    (current.functions?.bundle ?? null) === (request.functions?.bundle ?? null) &&
    sameJson(current.grants, request.grants)
  );
}

function withoutLinkIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutLinkIds);

  if (typeof value !== 'object' || value === null) return value;

  const copy: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(value)) {
    if (key === 'uniqueIdentifier' && typeof field === 'object' && field !== null && !Array.isArray(field)) {
      const { linkId, ...rest } = field as Record<string, unknown>;

      void linkId;

      copy[key] = withoutLinkIds(rest);
    } else {
      copy[key] = withoutLinkIds(field);
    }
  }

  return copy;
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(sorted(JSON.parse(JSON.stringify(value ?? null)) as unknown));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);

  if (typeof value !== 'object' || value === null) return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
  );
}
