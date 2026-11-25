import type { QueryDataType } from '@osdk/foundry.ontologies';
import { ApiError, invalidQueryParameterValue, invariant, type Fault } from '../errors/index.ts';
import type { CompiledFunction, CompiledOntology, JsonValue, ParameterId, QueryFunction } from '../ontology/index.ts';
import { RunFailure } from './pool.ts';

const OBJECT_NOT_FOUND_MESSAGE = 'Object not found';

const UNSUPPORTED_SEQUENCE_PARAMETERS = {
  originalErrorName: 'Ontos:UnsupportedEditSequence',
  userErrorMessage: 'The Action could not apply because of an unsupported edit sequence.',
  builderErrorMessage:
    'The Action produced more than one conflicting edit for the same Object. Change the Action rules or Function to emit a single edit sequence per Object.',
};

const HEAP_LIMIT_MESSAGE = 'The Function ran over its heap limit.';

const idsOf = (fn: CompiledFunction) => ({ functionRid: fn.rid, functionVersion: fn.version });

export function fault(error: unknown): Fault {
  return { kind: 'fault', error };
}

export function unsupportedSequence(): ApiError {
  return new ApiError(400, 'ApplyActionFailed', UNSUPPORTED_SEQUENCE_PARAMETERS);
}

export function refused({ fn }: { readonly fn: CompiledFunction }, message: string): ApiError {
  return new ApiError(400, 'FunctionExecutionFailed', { ...idsOf(fn), message });
}

interface MissingInput {
  readonly id: ParameterId;
  readonly value: JsonValue | undefined;
  readonly dataType: QueryDataType | undefined;
}

type Ids = ReturnType<typeof idsOf>;

const NO_INPUT_VALUES = {};

interface Errors {
  readonly userFacing: (ids: Ids, message: string, parameterId: string | undefined) => ApiError;
  readonly threw: (ids: Ids, message: string) => ApiError;
  readonly objectNotFound: (ids: Ids, input: MissingInput) => ApiError;
  readonly timedOut: (ids: Ids) => ApiError;
  readonly heapLimit: (ids: Ids) => ApiError;
}

const ERRORS: Readonly<Record<CompiledFunction['kind'], Errors>> = {
  edit: {
    userFacing: (ids, message, parameterId) =>
      new ApiError(400, 'FunctionEncounteredUserFacingError', {
        ...ids,
        message,
        ...(parameterId === undefined ? {} : { parameterId }),
      }),
    threw: (ids, message) => new ApiError(400, 'FunctionExecutionFailed', { ...ids, message }),
    objectNotFound: (ids) =>
      new ApiError(400, 'FunctionExecutionFailed', { ...ids, message: OBJECT_NOT_FOUND_MESSAGE }),
    timedOut: (ids) => new ApiError(400, 'FunctionExecutionTimedOut', ids),
    heapLimit: (ids) => new ApiError(400, 'FunctionExecutionFailed', { ...ids, message: HEAP_LIMIT_MESSAGE }),
  },
  query: {
    userFacing: (ids, message) => new ApiError(409, 'QueryEncounteredUserFacingError', { ...ids, message }),
    threw: (ids, message) => new ApiError(400, 'QueryRuntimeError', { ...ids, message, parameters: NO_INPUT_VALUES }),
    objectNotFound: (_ids, { id, value, dataType }) => invalidQueryParameterValue(dataType, id, value),
    timedOut: (ids) => new ApiError(400, 'QueryTimeExceededLimit', ids),
    heapLimit: (ids) => new ApiError(400, 'QueryMemoryExceededLimit', ids),
  },
};

export function functionError(
  error: unknown,
  fn: CompiledFunction,
  inputs: ReadonlyMap<ParameterId, JsonValue>,
  ontology: CompiledOntology,
): ApiError | Fault {
  if (!(error instanceof RunFailure)) return fault(error);

  const ids = idsOf(fn);
  const errors = ERRORS[fn.kind];
  const { failure } = error;

  switch (failure.kind) {
    case 'threw': {
      const { thrown } = failure;

      const apiError =
        thrown.error && thrown.name === 'UserFacingError'
          ? errors.userFacing(
              ids,
              thrown.message,
              thrown.parameterId !== undefined && fn.parameters.has(thrown.parameterId)
                ? thrown.parameterId
                : undefined,
            )
          : errors.threw(ids, thrown.message);

      if (thrown.stack !== undefined) {
        const cause = new Error(thrown.message);

        cause.stack = thrown.stack;

        apiError.cause = cause;
      }

      return apiError;
    }
    case 'objectNotFound': {
      const id = [...fn.parameters.keys()][failure.inputIndex];

      invariant(id !== undefined, `The Function ${fn.apiName} has no input ${failure.inputIndex}.`);

      return errors.objectNotFound(ids, {
        id,
        value: inputs.get(id),
        dataType: ontology.metadata.queryTypes[fn.apiName]?.parameters[id]?.dataType,
      });
    }
    case 'timedOut':
      return errors.timedOut(ids);
    case 'stopped': {
      if (isOutOfMemory(failure.cause)) return errors.heapLimit(ids);

      if (!failure.started) return fault(failure.cause);

      const apiError = errors.threw(
        ids,
        failure.cause instanceof Error ? failure.cause.message : String(failure.cause),
      );

      apiError.cause = failure.cause;

      return apiError;
    }
  }
}

export function invalidOutput(fn: QueryFunction, path: string, ontology: CompiledOntology): ApiError {
  const apiError = new ApiError(400, 'InvalidQueryOutputValue', {
    outputDataType: ontology.metadata.queryTypes[fn.apiName]?.output,
    ...idsOf(fn),
  });

  apiError.cause = new Error(
    `The Query Function ${fn.apiName} returned a value that is not of its output type, at ${path}.`,
  );

  return apiError;
}

function isOutOfMemory(cause: unknown): boolean {
  return cause instanceof Error && (cause as { code?: unknown }).code === 'ERR_WORKER_OUT_OF_MEMORY';
}
