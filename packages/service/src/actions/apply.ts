import type { ValidateActionResponseV2 } from '@osdk/foundry.ontologies';
import { personValue, type Db, type DbFailure } from '../db/index.ts';
import {
  actionTypeNotFound,
  ApiError,
  invariant,
  settle,
  type AsyncFallible,
  type Fallible,
  type Fault,
} from '../errors/index.ts';
import { runFunction } from '../functions/index.ts';
import type { RouteInput, WriteCtx } from '../handler/index.ts';
import type { CompiledActionType, EditFunction, JsonValue, ParameterId } from '../ontology/index.ts';
import { activeRoot, apiNameOf, spanOf, type LiveSpan } from '../spans/index.ts';
import type { Edit } from './edit.ts';
import { checkMembers } from './members.ts';
import { checkedVersions, checkMissing, loadObjectParameters, snapshotObjects, type LoadedObject } from './objects.ts';
import { evaluateCriteria } from './pure/criteria.ts';
import { historyEntries } from './pure/entries.ts';
import { checkParameters, defaultValues, omittedDefaults, type ParameterCheck } from './pure/parameters.ts';
import { readRequest, type ApplyRequest } from './pure/request.ts';
import { appliedResponse, validationResult } from './pure/response.ts';
import { newActionRid } from './pure/rid.ts';
import { runRules, withoutLinksOfDeleted } from './pure/rules.ts';
import { objectKey } from './pure/shared.ts';
import { checkValues } from './pure/values.ts';
import { runSnapshot } from './snapshot.ts';
import { ObjectChangedError, writeEdits, type CheckedVersion } from './write.ts';

const ATTEMPTS = 5;

type Failure = ApiError | DbFailure | Fault;

export async function* apply(input: RouteInput, ctx: WriteCtx): AsyncFallible<Response, Failure> {
  const now = new Date().toISOString();
  const actionType = yield* actionTypeOf(input, ctx);

  activeRoot()?.set('action.api_name', apiNameOf(actionType));

  const request = yield* readRequest(input.body);

  const parameters = yield* checkMembers(
    yield* checkParameters(actionType, request.parameters, ctx.ontology),
    ctx.activeMembers,
    input.signal,
  );

  const attempts = actionType.logic.kind === 'rules' ? ATTEMPTS : 1;

  for (let attempt = 1; ; attempt += 1) {
    const ran = await settle(
      spanOf('apply attempt', { 'apply.attempt': attempt }, errorOf, (attemptSpan) =>
        applyOnce(actionType, request, parameters, now, ctx, attemptSpan),
      ),
    );

    if (ran.ok) return ran.value;

    if (!(ran.error instanceof ObjectChangedError) || attempt === attempts) return yield ran.error;
  }
}

const errorOf = (failure: Failure): unknown => (failure instanceof ApiError ? failure : failure.error);

async function* applyOnce(
  actionType: CompiledActionType,
  request: ApplyRequest,
  parameters: ParameterCheck,
  now: string,
  ctx: WriteCtx,
  attemptSpan: LiveSpan<'apply attempt'>,
): AsyncFallible<Response, Failure> {
  const validate = async function* (db: Db): AsyncFallible<Validated, Failure> {
    const objects = yield* loadObjectParameters(db, ctx.reader, ctx.ontology, actionType, parameters.values);

    const criteria = evaluateCriteria(actionType, ctx.ontology, {
      parameters: parameters.values,
      objects,
      person: (fact) => personValue(ctx.reader, fact),
    });

    return {
      objects,
      validation: validationResult(parameters, criteria, request.mode, defaultValues(actionType, objects)),
    };
  };

  let validation: ValidateActionResponseV2;
  let edits: readonly Edit[];
  let versions: readonly CheckedVersion[];

  if (actionType.logic.kind === 'function') {
    const fn = ctx.ontology.functions.get(actionType.logic.function);

    invariant(
      fn?.kind === 'edit',
      `Ontology version ${ctx.ontology.version} has no edit Function ${actionType.logic.function}.`,
    );

    ({
      validation,
      edits,
      checked: versions,
    } = yield* checkAndRunFunction(actionType, fn, parameters.values, validate, ctx));

    if (validation.result === 'INVALID') return Response.json({ validation });

    edits = yield* withoutLinksOfDeleted(edits);
  } else {
    const { objects, validation: result } = yield* validate(ctx.db);

    validation = result;

    if (validation.result === 'INVALID' || request.mode === 'VALIDATE_ONLY') return Response.json({ validation });

    edits = yield* runRules(actionType.logic, ctx.ontology, {
      parameters: parameters.values,
      omittedDefaults: omittedDefaults(actionType, parameters),
      objects,
      now,
      user: ctx.caller.user,
    });

    versions = checkedVersions(edits, objects);
  }

  const checkedEdits = yield* checkValues(
    edits,
    ctx.ontology,
    actionType.logic.kind === 'function' ? 'function' : 'rules',
  );

  if (request.mode === 'VALIDATE_ONLY') return Response.json({ validation });

  const versioned = new Set(versions.map(({ object }) => objectKey(object)));
  const written = checkedEdits.filter((edit) => edit.type !== 'deleteObject' || versioned.has(objectKey(edit.object)));

  const operationId = newActionRid();
  const answer = appliedResponse(operationId, validation, checkedEdits, request.returnEdits, ctx.ontology);

  attemptSpan.set(
    'apply.object_edits',
    written.filter((edit) => edit.type !== 'addLink' && edit.type !== 'deleteLink').length,
  );

  if (written.length === 0) {
    yield* ctx.checkWrite();

    return Response.json(answer);
  }

  const action = { operationId, actionTypeRid: actionType.rid, userId: ctx.caller.user };

  yield* writeEdits(ctx.db, ctx.writer, ctx.ontology, written, versions, ctx.checkWrite, (previous) =>
    historyEntries(written, ctx.ontology, action, previous),
  );

  return Response.json(answer);
}

interface Validated {
  readonly objects: ReadonlyMap<ParameterId, LoadedObject | readonly LoadedObject[]>;
  readonly validation: ValidateActionResponseV2;
}

interface SnapshotRun {
  readonly validation: ValidateActionResponseV2;
  readonly edits: readonly Edit[];
  readonly found: readonly LoadedObject[];
}

async function* checkAndRunFunction(
  actionType: CompiledActionType,
  fn: EditFunction,
  inputs: ReadonlyMap<ParameterId, JsonValue>,
  validate: (db: Db) => AsyncFallible<Validated, Failure>,
  ctx: WriteCtx,
): AsyncFallible<
  {
    readonly validation: ValidateActionResponseV2;
    readonly edits: readonly Edit[];
    readonly checked: readonly CheckedVersion[];
  },
  Failure
> {
  const run = yield* runSnapshot(ctx.db, async function* (snapshot): AsyncFallible<SnapshotRun, Failure> {
    const { objects, validation } = yield* validate(snapshot);

    if (validation.result === 'INVALID') return { validation, edits: [], found: [] };

    const edits = yield* runFunction(fn, inputs, snapshot, ctx, actionType);

    const found = yield* snapshotObjects(snapshot, ctx.reader, ctx.ontology, edits, objects);

    return { validation, edits, found };
  });

  yield* checkMissing(ctx.db, ctx.reader, ctx.ontology, run.edits, run.found);

  const checked = run.found.map(({ objectType, primaryKey, version }) => ({
    object: { objectType, primaryKey },
    version,
  }));

  return { validation: run.validation, edits: run.edits, checked };
}

function* actionTypeOf(input: RouteInput, ctx: WriteCtx): Fallible<CompiledActionType, ApiError> {
  const apiName = input.params['action'] ?? '';
  const actionType = ctx.ontology.actionTypes.get(apiName);

  if (!actionType) return yield actionTypeNotFound(apiName, ctx.ontology.publishedActionTypeNames.get(apiName));

  return actionType;
}
