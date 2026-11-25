import type { MAX_BATCH } from '../auth/index.ts';
import type { ApiError, AsyncFallible, Fault } from '../errors/index.ts';
import type { MemberCheck } from '../handler/index.ts';
import type { ParameterCheck } from './pure/parameters.ts';

const MAX_USERS: typeof MAX_BATCH = 500;

export async function* checkMembers(
  check: ParameterCheck,
  activeMembers: MemberCheck,
  signal?: AbortSignal,
): AsyncFallible<ParameterCheck, ApiError | Fault> {
  const ids = [...new Set([...check.users.values()].flat())];

  if (ids.length === 0 || [...check.results.values()].some(({ result }) => result === 'INVALID')) return check;

  if (ids.length > MAX_USERS) return refused(check, () => true);

  const members = yield* activeMembers(ids, signal);

  return refused(check, (user) => !members.has(user));
}

function refused(check: ParameterCheck, refuse: (user: string) => boolean): ParameterCheck {
  const results = new Map(check.results);

  for (const [id, users] of check.users) {
    const result = results.get(id);

    if (result && users.some(refuse)) results.set(id, { ...result, result: 'INVALID' });
  }

  return { ...check, results };
}
