import { settle, type ApiError, type AsyncFallible, type Fault, type FallibleStream } from './errors/index.ts';
import type { WorkosPort } from './publish/index.ts';
import { workosPublish, workosUsers, type UserSource, type WorkosUser } from './auth/index.ts';
import {
  STUB_WORKOS_KEY,
  stubWorkos as unguarded,
  type StubMembership,
  type StubOptions,
  type StubWorkos,
} from '../testing/workos.ts';
import { routeRecording } from './tracing.test-utils.ts';

export * from '../testing/workos.ts';

export function stubWorkos(...args: Parameters<typeof unguarded>): StubWorkos {
  const stub = unguarded(...args);

  return { ...stub, fetch: routeRecording.recorder?.guard(stub.fetch) ?? stub.fetch };
}

export function stubUsers(
  users?: readonly WorkosUser[],
  memberships?: readonly StubMembership[],
  options?: StubOptions,
): UserSource {
  return workosUsers(STUB_WORKOS_KEY, { fetch: stubWorkos(users, memberships, options).fetch });
}

export function stubPublish(): WorkosPort {
  return workosPublish(STUB_WORKOS_KEY, { fetch: stubWorkos().fetch });
}

type PortFailure = ApiError | Fault;

function errorOf(failure: unknown): unknown {
  return typeof failure === 'object' && failure !== null && 'kind' in failure && 'error' in failure
    ? failure.error
    : failure;
}

export async function* failingWith(failure: PortFailure): AsyncFallible<never, PortFailure> {
  return yield failure;
}

export async function* failingStream(failure: PortFailure): FallibleStream<never, PortFailure> {
  yield* [];

  return failure;
}

export function rejectingPort(port: WorkosPort) {
  const value = async <T>(run: AsyncFallible<T, unknown>): Promise<T> => {
    const ran = await settle(run);

    if (ran.ok) return ran.value;

    throw errorOf(ran.error);
  };

  return {
    read: () => value(port.read()),
    apply: (step: Parameters<WorkosPort['apply']>[0]) => value(port.apply(step)),
    setPermissions: (...args: Parameters<WorkosPort['setPermissions']>) => value(port.setPermissions(...args)),
    memberRoles: async function* () {
      const failure = yield* port.memberRoles();

      if (failure !== undefined) throw errorOf(failure);
    },
  };
}
