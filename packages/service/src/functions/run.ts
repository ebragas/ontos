import { createHash } from 'node:crypto';
import { toEdits } from './edits.ts';
import { fault as serviceFault, functionError, invalidOutput } from './errors.ts';
import { checkOutput } from './output.ts';
import { callFunction, type BridgeAnswer } from './pool.ts';
import { ApiError, caught, invariant, settle, type AsyncFallible, type Fault } from '../errors/index.ts';
import { apiNameOf, spanOf, type LiveSpan } from '../spans/index.ts';
import type { Edit } from '../actions/index.ts';
import type { SnapshotDb } from '../db/index.ts';
import type { Ctx } from '../handler/index.ts';
import type {
  CompiledActionType,
  CompiledFunction,
  CompiledOntology,
  EditFunction,
  JsonValue,
  ParameterId,
  QueryFunction,
} from '../ontology/index.ts';
import type { Input } from './worker.ts';

export function runFunction(
  fn: EditFunction,
  inputs: ReadonlyMap<ParameterId, JsonValue>,
  snapshot: SnapshotDb,
  ctx: Ctx,
  actionType: CompiledActionType,
): AsyncFallible<readonly Edit[], ApiError | Fault>;
export function runFunction(
  fn: QueryFunction,
  inputs: ReadonlyMap<ParameterId, JsonValue>,
  snapshot: SnapshotDb,
  ctx: Ctx,
): AsyncFallible<JsonValue, ApiError | Fault>;
export async function* runFunction(
  fn: CompiledFunction,
  inputs: ReadonlyMap<ParameterId, JsonValue>,
  snapshot: SnapshotDb,
  ctx: Ctx,
  actionType?: CompiledActionType,
): AsyncFallible<readonly Edit[] | JsonValue, ApiError | Fault> {
  const attributes = {
    'function.api_name': apiNameOf(fn),
    'function.kind': fn.kind,
    ...(actionType ? { 'action.api_name': apiNameOf(actionType) } : {}),
  };

  return yield* spanOf('function run', attributes, errorOf, async function* (functionRun): AsyncFallible<
    readonly Edit[] | JsonValue,
    ApiError | Fault
  > {
    const returned = yield* callIn(functionRun, fn, inputs, snapshot, ctx);

    if (fn.kind === 'edit') return yield* toEdits(returned, ctx.ontology, fn);

    const checked = checkOutput(returned, fn.output);

    if (!checked.ok) return yield invalidOutput(fn, checked.path, ctx.ontology);

    return checked.value;
  });
}

const errorOf = (failure: ApiError | Fault): unknown => (failure instanceof ApiError ? failure : failure.error);

async function* callIn(
  functionRun: LiveSpan<'function run'>,
  fn: CompiledFunction,
  inputs: ReadonlyMap<ParameterId, JsonValue>,
  snapshot: SnapshotDb,
  ctx: Ctx,
): AsyncFallible<unknown, ApiError | Fault> {
  const { ontology } = ctx;
  const bundle = ontology.functionBundle;

  invariant(
    bundle !== undefined,
    `Ontology version ${ontology.version} has no bundle with the Function ${fn.apiName}.`,
  );

  let fault: Error | undefined;

  const bridge = functionRun.bind(async (request: Request, skipTotalCount?: true): Promise<BridgeAnswer> => {
    const answered = await caught(async () => {
      const response = await ctx.handleTrusted(request, {
        db: snapshot,
        reader: ctx.reader,
        ontology,
        caller: ctx.caller,
        checkWrite: ctx.checkWrite,
        ...(ctx.loadDerivedProperties ? { loadDerivedProperties: true } : {}),
        ...(skipTotalCount ? { includeTotalCount: false } : {}),
      });

      return { response, body: response.body === null ? '' : await response.text() };
    });

    if (!answered.ok) {
      if (!request.signal.aborted)
        fault ??= answered.error instanceof Error ? answered.error : new Error(String(answered.error));

      return { status: 500, headers: [], body: '' };
    }

    const { response, body } = answered.value;

    if (response.status >= 500)
      fault ??= new Error(`${request.method} ${new URL(request.url).pathname} got ${response.status}: ${body}`);

    return { status: response.status, headers: [...response.headers], body };
  });

  const called = await settle(
    callFunction(
      {
        bundle,
        function: fn.apiName,
        inputs: inputsOf(fn, inputs, ontology),
        ontologyRid: ontology.metadata.ontology.rid,
        clientKey: clientKeyOf(ontology),
      },
      bridge,
    ),
  );

  if (fault) return yield serviceFault(clientFault(fault));

  if (!called.ok) return yield functionError(called.error, fn, inputs, ontology);

  return called.value;
}

export function clientKeyOf(ontology: CompiledOntology): string {
  const hash = createHash('sha256');

  hash.update(`${ontology.metadata.ontology.rid}\0${ontology.productRid}\0${ontology.version}\0`);

  for (const names of [
    Object.keys(ontology.metadata.objectTypes).sort(),
    Object.keys(ontology.metadata.actionTypes).sort(),
    Object.keys(ontology.metadata.queryTypes).sort(),
  ]) {
    for (const name of names) hash.update(name).update('\x1f');

    hash.update('\0');
  }

  return hash.digest('hex');
}

function clientFault(cause: Error): Error {
  return new Error("A request of the Function's client got a 5xx, so the run gets 500.", { cause });
}

function inputsOf(
  fn: CompiledFunction,
  inputs: ReadonlyMap<ParameterId, JsonValue>,
  ontology: CompiledOntology,
): Input[] {
  return [...fn.parameters.values()].map(({ id, type }) => {
    const sent = inputs.get(id);
    const value = sent === undefined && (type.kind === 'list' || type.kind === 'objectList') ? [] : sent;

    if (type.kind === 'struct') return { value: withoutNulls(value) };

    if (type.kind === 'list' && type.element.kind === 'struct' && Array.isArray(value))
      return { value: value.map(withoutNulls) };

    if (type.kind !== 'object' && type.kind !== 'objectList') return { value };

    const keyProperty = ontology.objectTypes.get(type.objectType)?.primaryKey.apiName;

    invariant(keyProperty !== undefined, `Ontology version ${ontology.version} has no Object Type ${type.objectType}.`);

    if (type.kind === 'object' && typeof value === 'string')
      return { objectType: type.objectType, keyProperty, primaryKey: value };

    if (
      type.kind === 'objectList' &&
      Array.isArray(value) &&
      value.every((key): key is string => typeof key === 'string')
    ) {
      return { objectType: type.objectType, keyProperty, primaryKeys: value };
    }

    return { value };
  });
}

function withoutNulls(value: JsonValue | undefined): JsonValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;

  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null));
}
