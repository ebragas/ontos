import {
  authenticate,
  authenticateMcp,
  dataCaller,
  memberCaller,
  metadataUrl,
  permittedCaller,
  tokenRouteFault,
  type Caller,
  type KnownCaller,
} from '../auth/index.ts';
import {
  ApiError,
  attempt,
  caught,
  internalError,
  invariant,
  outsideFailure,
  settle,
  unsupportedFeature,
  type AsyncFallible,
  type Fallible,
  type Fault,
} from '../errors/index.ts';
import {
  activeTraceId,
  mcpMethodOf,
  mcpToolOf,
  rootSpan,
  span,
  tracedUser,
  type LiveSpan,
  type McpToolName,
  type TraceIds,
} from '../spans/index.ts';
import { COLD_START, coldStart, coldStartError, tracedCompile } from './coldStart.ts';
import type {
  Ctx,
  Handle,
  HandleInput,
  HandleTrusted,
  McpLogFields,
  MissingSettings,
  Route,
  RouteInput,
  RouteLogFields,
  Settings,
} from './context.ts';
import { derivedTrace } from './derivedTrace.ts';
import { DEV_PRODUCTION_REASON, isProductionEnvironment } from './env.ts';
import { errorLogFields, errorResponse, faultFields, stackOf, type OnError, type RequestLine } from './faults.ts';
import { matchRoute, routeKeyOf } from './match.ts';
import { callToolOf, checkWriteOf, openRequest, runOntologyRoute, writesOf } from './ontologyRequest.ts';
import { loadMcp, mcpOn, type RouteMatch } from './routes.ts';
import { answered, border, serve, type Failure } from './serve.ts';

export type * from './context.ts';

export { inputFromEnv, settingsFromEnv } from './env.ts';

export * from './match.ts';

export const handle: Handle = async (request, input) => {
  if ('missing' in input) return settingMissing(request, input);

  if (
    (input.identity?.mode === 'dev' || input.settings.authMode === 'dev') &&
    isProductionEnvironment(input.settings.environment)
  ) {
    return settingMissing(request, {
      missing: ['ONTOS_AUTH_MODE'],
      reason: DEV_PRODUCTION_REASON,
      ...(input.reportFault === undefined ? {} : { reportFault: input.reportFault }),
    });
  }

  const arrivedAt = Date.now();
  const match = matchRoute(request.method, new URL(request.url).pathname);

  if (!match) {
    console.log(JSON.stringify({}));

    return new Response(null, { status: 404 });
  }

  const line: RequestLine = {};

  return rootSpan(
    { 'route.key': routeKeyOf(match.route), 'route.access': match.route.access },
    (root, ids) => answer(request, match, input, { arrivedAt, root, ids, line }),
    request.headers.get('traceparent'),
  ).then(({ response, ids, bodyEnd }) => {
    const settled = bodyEnd.then((end) => {
      if (typeof end !== 'object') return;

      const cut = { route: `${match.route.method} ${match.route.path}`, errorName: internalError().errorName };

      caught(() => input.reportFault?.(end.failed, faultFields(cut, line, ids)));
    });

    input.bodyPending?.(settled);

    return response;
  });
};

interface Arrival {
  readonly arrivedAt: number;
  readonly root: LiveSpan<'root'>;
  readonly ids: TraceIds | undefined;
  readonly line: RequestLine;
}

function answer(
  request: Request,
  match: RouteMatch,
  input: HandleInput,
  { arrivedAt, root, ids, line }: Arrival,
): Promise<Response> {
  if (ids !== undefined) line.traceId = ids.traceId;

  const noteVersion = (version: number): void => {
    line.ontologyVersion = version;

    root.set('ontology.version', version);
  };

  const fail: OnError = (error, fields, status) => {
    Object.assign(line, fields);

    line.stack = stackOf(error);

    if (status >= 500) input.reportFault?.(error, faultFields(fields, line, ids));
  };

  const { route } = match;
  const { settings } = input;

  const responding = serve(
    request,
    match,
    async function* (readInput): AsyncFallible<Response, Failure> {
      if (route.access === 'token')
        return yield* attempt(
          () => runTokenRoute(route, request, settings, match, fail, input.identity),
          outsideFailure,
        );

      if (route.access === 'public') return yield* answered(route.run(yield* readInput(), settings));

      const known = (who: KnownCaller): void => {
        line.userId = who.user;
        line.callerKind = who.kind;

        root.set('user.id', tracedUser(who));

        root.set('caller.kind', who.kind);
      };

      let caller: Caller;
      let mcp: McpLogFields | undefined;
      let tool: McpToolName | undefined;

      if (route.access === 'mcp') {
        if (!mcpOn(settings)) return new Response(null, { status: 404 });

        let checked;

        if (input.identity !== undefined) {
          checked = yield* input.identity.authenticateMcp(request);
        } else {
          invariant(settings.authkitDomain !== undefined, 'AUTHKIT_DOMAIN is not set.');

          checked = yield* authenticateMcp(
            request,
            { authkitDomain: settings.authkitDomain, baseUrl: settings.auth.baseUrl },
            input.keys.authkit,
          );
        }

        const { clientId, ...person } = checked;

        caller = person;

        known(person);

        const protocolVersion = request.headers.get('mcp-protocol-version');

        mcp = {
          ...(clientId === undefined ? {} : { clientId }),
          ...(protocolVersion === null ? {} : { protocolVersion }),
        };
      } else if (input.identity !== undefined) {
        caller = yield* input.identity.authenticate(request, {
          access: route.access === 'publish' ? 'publish' : 'data',
          known,
        });
      } else {
        caller = yield* authenticate(
          request,
          settings.auth,
          input.keys,
          { authkitDomain: settings.authkitDomain, applications: input.users.applications },
          known,
        );
      }

      if (COLD_START[route.access] === 'request') {
        const cold = await settle(coldStart(input.directDb, root, input.onBackground));

        if (!cold.ok) {
          const error = coldStartError(cold.error);
          const fields = errorLogFields(error, crypto.randomUUID(), match);

          fail(cold.error, fields, error.status);

          return errorResponse(error, fields.errorInstanceId);
        }
      }

      const log = ({ mcp: more, ...fields }: RouteLogFields) => {
        Object.assign(line, fields);

        if (more !== undefined) line.mcp = { ...line.mcp, ...more };
      };

      const readChecked = async function* (): AsyncFallible<RouteInput, ApiError | Fault> {
        yield* checkQuery(new URL(request.url).searchParams);

        const routeInput = yield* readInput();

        if (settings.logRequestBodies) line.body = routeInput.body;

        if (mcp !== undefined) {
          const { mcpLogFields } = yield* loadMcp();
          const call = mcpLogFields(routeInput.body);

          line.mcp = { ...call, ...mcp };

          if (call.method !== undefined) root.set('mcp.method.name', mcpMethodOf(call.method));

          tool = call.tool === undefined ? undefined : mcpToolOf(call.tool);

          if (tool !== undefined) root.set('mcp.tool.name', tool);
        }

        return routeInput;
      };

      if (route.access === 'publish') {
        const routeInput = yield* readChecked();

        yield* checkPublishLimits(caller, routeInput.body);

        if (caller.kind === 'person' || caller.kind === 'service') {
          const permitted = yield* permittedCaller(caller, input.users.permissions, request.signal);

          if (!permitted.permissions.includes('ontology:install') && !permitted.permissions.includes('*'))
            return yield new ApiError(403, 'Default:PermissionDenied');
        }

        return yield* answered(route.run(routeInput, { caller, settings, log, workos: input.workos }, input.directDb));
      }

      const person = yield* dataCaller(caller);

      const permitted =
        route.access === 'ontology'
          ? yield* permittedCaller(person, input.users.permissions, request.signal)
          : undefined;

      const opened = permitted ? yield* openRequest(input.db, match.params['ontology'] ?? '', permitted) : undefined;
      const routeInput = yield* readChecked();

      if (route.access === 'users') return yield* answered(route.run(routeInput, input.users, person));

      if (route.access === 'organization') {
        if (route.permissions === false) {
          return yield* answered(
            route.run(routeInput, {
              db: input.db,
              caller: yield* memberCaller(person, input.users, request.signal),
              log,
              compile: tracedCompile,
            }),
          );
        }

        return yield* answered(
          route.run(routeInput, {
            db: input.db,
            caller: yield* permittedCaller(person, input.users.permissions, request.signal),
            log,
            compile: tracedCompile,
          }),
        );
      }

      const noView: Omit<Ctx, 'reader' | 'ontology' | 'caller'> = {
        db: input.db,
        handleTrusted,
        log,
        checkWrite: checkWriteOf(request.signal, arrivedAt, route.access === 'mcp' ? 'mcp' : 'ontology'),
        traceDerived: derivedTrace(root),
        ...(input.settings.loadDerivedProperties ? { loadDerivedProperties: true } : {}),
      };

      if (route.access === 'mcp') {
        return yield* answered(
          route.run(
            { request, body: routeInput.body },
            callToolOf({
              noView,
              person,
              signal: request.signal,
              users: input.users,
              match,
              tool,
              onVersion: noteVersion,
              fail,
              coldStart: () => coldStart(input.directDb, root, input.onBackground),
            }),
          ),
        );
      }

      invariant(permitted && opened, `The route ${route.path} has no Ontology.`);

      noteVersion(opened.view.ontology.version);

      const ctx: Ctx = { ...noView, caller: permitted, reader: opened.reader, ontology: opened.view.ontology };

      return yield* answered(runOntologyRoute(route, routeInput, ctx, writesOf(opened, input.users, permitted)));
    },
    fail,
    (status) =>
      route.access === 'mcp' && status === 401
        ? { 'www-authenticate': `Bearer resource_metadata="${metadataUrl(input.settings.auth.baseUrl)}"` }
        : {},
    {
      ...(settings.maxBodyBytes === undefined ? {} : { maxBytes: settings.maxBodyBytes }),
      ...(settings.bodyTimeoutMs === undefined ? {} : { timeoutMs: settings.bodyTimeoutMs }),
    },
  );

  return responding.then((response) => {
    console.log(JSON.stringify(line));

    return response;
  });
}

type TokenRoute = Extract<Route, { readonly access: 'token' }>;

function runTokenRoute(
  route: TokenRoute,
  request: Request,
  settings: Settings,
  match: RouteMatch,
  fail: OnError,
  identity?: HandleInput['identity'],
): Promise<Response> {
  return border(
    () => answered(identity ? identity.tokenRoute(request, settings) : route.run(request, settings)),
    (error) => {
      const apiError = error instanceof ApiError ? error : internalError();

      fail(error, errorLogFields(apiError, crypto.randomUUID(), match), apiError.status);

      return tokenRouteFault(apiError.status);
    },
  );
}

function settingMissing(request: Request, { missing, reason, reportFault }: MissingSettings): Response {
  const failure = new Error(reason ?? `These environment variables are missing or not valid: ${missing.join(', ')}.`);
  const error = new ApiError(503, 'OntologyService:SettingMissing');
  const match = matchRoute(request.method, new URL(request.url).pathname);
  const fields = errorLogFields(error, crypto.randomUUID(), match);

  console.log(JSON.stringify({ ...fields, stack: stackOf(failure) }));

  reportFault?.(failure, faultFields(fields));

  if (match?.route.access === 'token') return tokenRouteFault(error.status);

  return errorResponse(error, fields.errorInstanceId);
}

export const handleTrusted: HandleTrusted = (request, input) => {
  const match = matchRoute(request.method, new URL(request.url).pathname);

  if (!match) return Promise.resolve(new Response(null, { status: 404 }));

  return span('function client', { 'route.key': routeKeyOf(match.route) }, (client) =>
    serve(
      request,
      match,
      async function* (readInput): AsyncFallible<Response, Failure> {
        const { route } = match;

        if (route.access !== 'ontology' || route.writes || route.runsFunction)
          return yield new ApiError(403, 'Default:PermissionDenied');

        yield* checkQuery(new URL(request.url).searchParams);

        const { ontology } = input;

        yield* checkOntology(match.params, ontology.metadata.ontology.rid);

        const routeInput = yield* readInput();

        return yield* answered(
          route.run(routeInput, {
            db: input.db,
            reader: input.reader,
            ontology,
            caller: input.caller,
            handleTrusted,
            log: () => undefined,
            checkWrite: input.checkWrite,
            traceDerived: derivedTrace(undefined),
            ...(input.loadDerivedProperties ? { loadDerivedProperties: true } : {}),
            ...(input.includeTotalCount === false ? { includeTotalCount: false } : {}),
          }),
        );
      },
      (error, fields) => {
        const traceId = activeTraceId();

        console.log(
          JSON.stringify({ ...fields, ...(traceId === undefined ? {} : { traceId }), stack: stackOf(error) }),
        );
      },
    ).then((response) => {
      client.set('http.status_code', response.status);

      const body = response.body === null ? Promise.resolve(null) : response.arrayBuffer();

      return body.then(
        (bytes) =>
          new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers }),
      );
    }),
  );
};

const OUTSIDE_V1_PARAMETERS = ['branch', 'transactionId', 'scenarioRid'];

function* checkQuery(query: URLSearchParams): Fallible<void, ApiError> {
  const feature = OUTSIDE_V1_PARAMETERS.find((name) => query.has(name));

  if (feature !== undefined) return yield unsupportedFeature(feature);
}

function* checkOntology(params: Readonly<Record<string, string>>, ontologyRid: string): Fallible<void, ApiError> {
  const { ontology } = params;

  if (ontology !== undefined && ontology !== ontologyRid)
    return yield new ApiError(404, 'OntologyNotFound', { ontologyRid: ontology });
}

function* checkPublishLimits(caller: Caller, body: unknown): Fallible<void, ApiError> {
  if (caller.kind !== 'publish' && !validateOnly(body)) return yield new ApiError(403, 'Default:PermissionDenied');
}

function validateOnly(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { validateOnly?: unknown }).validateOnly === true;
}
