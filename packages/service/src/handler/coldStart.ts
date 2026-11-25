import { warmWorker } from '../actions/index.ts';
import { applyEngineChanges, type Db } from '../db/index.ts';
import { ApiError, caught, settle, type AsyncFallible } from '../errors/index.ts';
import { checkOntologyVersions, type CompileRun, type WarmCandidate } from '../ontology/index.ts';
import { spanOf, type LiveSpan } from '../spans/index.ts';
import type { HandleInput, Route } from './context.ts';
import { thrown, type Failure } from './serve.ts';

export const COLD_START: Readonly<Record<Route['access'], 'request' | 'tool call' | 'none'>> = {
  ontology: 'request',
  organization: 'request',
  publish: 'request',
  mcp: 'tool call',
  token: 'none',
  public: 'none',
  users: 'none',
};

export const tracedCompile: CompileRun = (version, run) =>
  spanOf('ontology compile', { 'ontology.version': version }, thrown, run);

let coldStartState: { readonly running: Promise<Result<void>> } | 'passed' | undefined;

const asThrown = (error: unknown): unknown => error;

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

const flat = <T>(ran: Result<Result<T>>): Result<T> => (ran.ok ? ran.value : ran);

export async function* coldStart(
  directDb: Db,
  root: LiveSpan<'root'>,
  onBackground?: HandleInput['onBackground'],
): AsyncFallible<void, unknown> {
  if (coldStartState === 'passed') return;

  root.set('ontology.cold_start', true);

  const joined = coldStartState?.running;

  if (joined) {
    const waited = await caught(() =>
      settle(
        spanOf('cold start', { 'cold_start.role': 'joined' }, asThrown, async function* (): AsyncFallible<
          void,
          unknown
        > {
          const ran = flat(await caught(() => joined));

          if (!ran.ok) return yield ran.error;
        }),
      ),
    );

    const ran = flat(waited);

    if (!ran.ok) return yield ran.error;

    return;
  }

  const running = settle(
    spanOf('cold start', { 'cold_start.role': 'ran' }, asThrown, () => runColdStart(directDb, onBackground)),
  );

  coldStartState = { running };

  const ran = flat(await caught(() => running));

  coldStartState = ran.ok ? 'passed' : undefined;

  if (!ran.ok) return yield ran.error;
}

async function* runColdStart(directDb: Db, onBackground?: HandleInput['onBackground']): AsyncFallible<void, unknown> {
  const ran = flat(
    await caught(async () => {
      const settled = await settle(coldStartWork(directDb, onBackground));

      return settled.ok ? settled : { ok: false as const, error: thrown(settled.error) };
    }),
  );

  if (ran.ok) return;

  console.error('The cold start failed, so this request gets 503. The next request tries again.', ran.error);

  return yield ran.error;
}

async function* coldStartWork(directDb: Db, onBackground?: HandleInput['onBackground']): AsyncFallible<void, Failure> {
  yield* applyEngineChanges(directDb);

  const scheduleWarm = onBackground ? (target: WarmCandidate) => onBackground(warmWorker(target)) : undefined;

  yield* checkOntologyVersions(directDb, tracedCompile, scheduleWarm);
}

export function coldStartError(error: unknown): ApiError {
  return error instanceof ApiError && error.status === 503
    ? error
    : new ApiError(503, 'OntologyService:EngineChangesFailed');
}
