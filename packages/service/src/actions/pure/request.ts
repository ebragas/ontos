import type { ApplyActionMode, ReturnEditsMode } from '@osdk/foundry.ontologies';
import type { ApiError, Fallible } from '../../errors/index.ts';
import type { JsonValue, ParameterId } from '../../ontology/index.ts';
import { invalidBody, isRecord } from './shared.ts';

export interface ApplyRequest {
  readonly parameters: Readonly<Record<ParameterId, JsonValue>>;
  readonly mode: ApplyActionMode;
  readonly returnEdits: ReturnEditsMode;
}

const MODES: readonly ApplyActionMode[] = ['VALIDATE_ONLY', 'VALIDATE_AND_EXECUTE'];
const RETURN_EDITS: readonly ReturnEditsMode[] = ['NONE', 'ALL', 'ALL_V2_WITH_DELETIONS'];

export function* readRequest(body: JsonValue | undefined): Fallible<ApplyRequest, ApiError> {
  if (!isRecord(body)) return yield invalidBody();

  const { parameters, options = {} } = body;

  if (!isRecord(parameters) || !isRecord(options)) return yield invalidBody();

  const { mode: sentMode = 'VALIDATE_AND_EXECUTE', returnEdits: sentReturnEdits = 'NONE' } = options;
  const mode = MODES.find((known) => known === sentMode);
  const returnEdits = RETURN_EDITS.find((known) => known === sentReturnEdits);

  if (mode === undefined || returnEdits === undefined) return yield invalidBody();

  return { parameters, mode, returnEdits };
}
