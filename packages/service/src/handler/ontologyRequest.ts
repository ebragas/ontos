import { permittedCaller, type DataCaller, type UserSource } from '../auth/index.ts';
import { openReader, type Db, type Reader, type Writer } from '../db/index.ts';
import {
  ApiError,
  attempt,
  errorBody,
  internalError,
  invariant,
  outsideFailure,
  settle,
  type AsyncFallible,
  type Fallible,
  type Fault,
} from '../errors/index.ts';
import { listOntologyEntries, openOntology, type JsonValue, type OntologyView } from '../ontology/index.ts';
import { span, spanOf, type McpToolName } from '../spans/index.ts';
import { coldStartError, tracedCompile, type coldStart } from './coldStart.ts';
import type {
  CallTool,
  ChooseOntology,
  Ctx,
  McpCtx,
  MemberCheck,
  OntologyRouteKey,
  OrganizationCaller,
  Route,
  RouteAnswer,
  RouteInput,
  RouteResult,
  RunRoute,
  WriteCtx,
} from './context.ts';
import { errorLogFields, type OnError } from './faults.ts';
import { routes, type RouteMatch } from './routes.ts';
import { answered, bordered, thrown, type Failure } from './serve.ts';

type OntologyRoute = Extract<Route, { readonly access: 'ontology' }>;

type CtxWithNoView = Omit<Ctx, 'reader' | 'ontology' | 'caller'>;

interface OpenedRequest {
  readonly view: OntologyView;
  readonly reader: Reader;
  readonly writer: Writer;
}

type WriteFields = Pick<WriteCtx, 'writer' | 'activeMembers'>;

export async function* openRequest(
  db: Db,
  rid: string,
  caller: OrganizationCaller,
): AsyncFallible<OpenedRequest, Failure> {
  const view = yield* spanOf('ontology view', {}, thrown, async function* (s): AsyncFallible<OntologyView, Failure> {
    let hit = true;

    const opened = yield* openOntology(db, rid, caller, (version, run) => {
      hit = false;

      return tracedCompile(version, run);
    });

    s.set('ontology.version', opened.ontology.version);

    s.set('ontology.cache.hit', hit);

    return opened;
  });

  const effectiveCaller: OrganizationCaller = { ...caller, permissions: view.effectivePermissions };
  const { reader, writer } = yield* openReader(db, view.schemas, view.personAttributes, effectiveCaller);

  return { view, reader, writer };
}

export function writesOf(opened: OpenedRequest, users: UserSource, caller: OrganizationCaller): WriteFields {
  return { writer: opened.writer, activeMembers: memberCheckOf(users, caller) };
}

function memberCheckOf(users: UserSource, caller: OrganizationCaller): MemberCheck {
  return async function* (userIds, signal): AsyncFallible<ReadonlySet<string>, ApiError | Fault> {
    const found = yield* users.members(userIds, caller.organization, signal);

    return new Set([...found.values()].filter((user) => user.status === 'ACTIVE').map((user) => user.id));
  };
}

export function runOntologyRoute(route: OntologyRoute, input: RouteInput, ctx: Ctx, writes: WriteFields): RouteAnswer {
  return route.writes ? route.run(input, { ...ctx, ...writes }) : route.run(input, ctx);
}

interface ToolCallParts {
  readonly noView: CtxWithNoView;
  readonly person: DataCaller;
  readonly signal: AbortSignal;
  readonly users: UserSource;
  readonly match: RouteMatch;
  readonly tool: McpToolName | undefined;
  readonly onVersion: (version: number) => void;
  readonly fail: OnError;
  readonly coldStart: () => ReturnType<typeof coldStart>;
}

export function callToolOf({
  noView,
  person,
  signal,
  users,
  match,
  tool,
  onVersion,
  fail,
  coldStart: runColdStart,
}: ToolCallParts): CallTool {
  const names = tool === undefined ? {} : { 'mcp.tool.name': tool, 'gen_ai.tool.name': tool };

  const toolCall = async function* (
    choose: ChooseOntology,
    call: (ctx: McpCtx) => AsyncFallible<RouteResult, ApiError | Fault>,
  ): AsyncFallible<RouteResult, Failure> {
    const permitted = await settle(permittedCaller(person, users.permissions, signal));

    if (!permitted.ok) return reportError(thrown(permitted.error), match, fail);

    const caller = permitted.value;

    const cold = await settle(runColdStart());

    if (!cold.ok) return reportError(cold.error, match, fail, coldStartError(cold.error));

    const choice = yield* choose(yield* listOntologyEntries(noView.db, caller.organization));

    if (typeof choice !== 'string') return choice;

    const opened = yield* openRequest(noView.db, choice, caller);

    onVersion(opened.view.ontology.version);

    const ctx: Ctx = { ...noView, caller, reader: opened.reader, ontology: opened.view.ontology };

    return yield* call({ ...ctx, runRoute: runRouteOf(ctx, writesOf(opened, users, caller), opened.view.rid, fail) });
  };

  return (choose, call) =>
    span('mcp tool', names, async () => {
      const ran = await settle(bordered(() => toolCall(choose, call)));

      return ran.ok ? ran.value : reportError(ran.error, match, fail);
    });
}

function runRouteOf(ctx: Ctx, writes: WriteFields, ontologyRid: string, fail: OnError): RunRoute {
  return (call) =>
    span('mcp route', { 'route.key': call.key }, async (s): Promise<RouteResult> => {
      const params = { ontology: ontologyRid, ...call.params };
      const route = ontologyRoute(call.key);

      const ran = await settle(
        bordered(async function* (): AsyncFallible<RouteResult, Failure> {
          const response = yield* answered(
            runOntologyRoute(route, { params, query: new URLSearchParams(), body: call.body }, ctx, writes),
          );

          return {
            status: response.status,
            body: (yield* attempt(() => response.json(), outsideFailure)) as JsonValue,
          };
        }),
      );

      const result = ran.ok ? ran.value : reportError(ran.error, { route, params }, fail);

      s.set('http.status_code', result.status);

      return result;
    });
}

function reportError(
  error: unknown,
  match: Pick<RouteMatch, 'route' | 'params'>,
  fail: OnError,
  apiError = error instanceof ApiError ? error : internalError(),
): RouteResult {
  const fields = errorLogFields(apiError, crypto.randomUUID(), match);

  fail(error, fields, apiError.status);

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- ApiError types its parameters as unknown, and errorResponse sends the same body with Response.json.
  return { status: apiError.status, body: errorBody(apiError, fields.errorInstanceId) as unknown as JsonValue };
}

function ontologyRoute(key: OntologyRouteKey): OntologyRoute {
  const space = key.indexOf(' ');
  const [method, path] = [key.slice(0, space), key.slice(space + 1)];

  const route = routes.find(
    (candidate): candidate is OntologyRoute =>
      candidate.access === 'ontology' && candidate.method === method && candidate.path === path,
  );

  invariant(route, `The route table has no ontology route ${key}.`);

  return route;
}

const APPLY_DEADLINE_MS = { ontology: 120_000, mcp: 50_000 } as const;

export function checkWriteOf(signal: AbortSignal, arrivedAt: number, kind: 'ontology' | 'mcp'): Ctx['checkWrite'] {
  const deadline = arrivedAt + APPLY_DEADLINE_MS[kind];

  return function* (): Fallible<number, ApiError> {
    if (signal.aborted) return yield new ApiError(400, 'ActionRequestAborted');

    const remaining = deadline - Date.now();

    if (remaining < 1) return yield new ApiError(400, 'ActionDeadlineExceeded');

    return remaining;
  };
}
