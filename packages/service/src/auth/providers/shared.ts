import { createHash, timingSafeEqual } from 'node:crypto';
import { errors } from 'jose';
import { ApiError, settle, type AsyncFallible, type FallibleStream } from '../../errors/index.ts';
import type { RoleSlug, WorkosPort, WorkosRoles } from '../../publish/index.ts';
import type { Caller } from '../caller.ts';
import { tracedFallible } from '../workosCalls.ts';
import type { Failure } from '../workosErrors.ts';

const KEY_SOURCE_FAULTS: ReadonlySet<string> = new Set([
  'ERR_JOSE_GENERIC',
  'ERR_JWKS_TIMEOUT',
  'ERR_JWKS_INVALID',
  'ERR_JWK_INVALID',
]);

function tokenFailure(failure: Failure): boolean {
  return (
    !(failure instanceof ApiError) &&
    failure.error instanceof errors.JOSEError &&
    !KEY_SOURCE_FAULTS.has(failure.error.code)
  );
}

export function bearerAuth<C extends Caller>(
  request: Request,
  check: (token: string) => AsyncFallible<C | undefined, Failure>,
): AsyncFallible<C, Failure> {
  return tracedFallible('token check', {}, async function* (): AsyncFallible<C, Failure> {
    const header = request.headers.get('authorization');

    if (!header?.startsWith('Bearer ') || header.length === 'Bearer '.length) {
      return yield new ApiError(401, 'MissingCredentials');
    }

    const checked = await settle(check(header.slice('Bearer '.length)));

    if (!checked.ok && !tokenFailure(checked.error)) return yield checked.error;

    if (!checked.ok || !checked.value) return yield new ApiError(401, 'Default:Unauthorized');

    return checked.value;
  });
}

export function constantTimeEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a, 'utf8').digest();
  const hashB = createHash('sha256').update(b, 'utf8').digest();

  return timingSafeEqual(hashA, hashB);
}

// oxlint-disable-next-line require-yield -- a no-op publish port performs no external reads and cannot fail.
async function* emptyRoles(): AsyncFallible<WorkosRoles, Failure> {
  return { permissions: new Map(), roles: new Map() };
}

// oxlint-disable-next-line require-yield -- a no-op publish port has no external member roles.
async function* noMemberRoles(): FallibleStream<readonly RoleSlug[], Failure> {
  return undefined;
}

// oxlint-disable-next-line require-yield -- a no-op publish port performs no external writes and cannot fail.
async function* noopWrite(): AsyncFallible<void, Failure> {
  return undefined;
}

export function noopWorkosPublish(): WorkosPort {
  return {
    read: emptyRoles,
    memberRoles: noMemberRoles,
    apply: noopWrite,
    setPermissions: noopWrite,
  };
}
