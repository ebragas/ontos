import { z } from 'zod';
import { ApiError, type Fault } from '../errors/index.ts';

export const READ_LIMIT_MS = 5_000;

const DEFAULT_RETRY_AFTER_SECONDS = '10';

export function workosUnavailable(): ApiError {
  return new ApiError(503, 'OntologyService:WorkosUnavailable', {}, { 'retry-after': DEFAULT_RETRY_AFTER_SECONDS });
}

export type Failure = ApiError | Fault;

export function workosFault(message: string): Fault {
  return { kind: 'fault', error: new Error(message) };
}

export const workosPage = <Item extends z.ZodType>(item: Item) =>
  z.object({ data: z.array(item), list_metadata: z.object({ after: z.string().nullish() }).nullish() });
