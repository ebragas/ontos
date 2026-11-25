import {
  context,
  createContextKey,
  isSpanContextValid,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context,
  type SpanContext,
} from '@opentelemetry/api';
import { caught } from '../errors/index.ts';
import type { StartAttributes } from './catalog.ts';
import { span, type LiveSpan } from './span.ts';

const ROOT_KEY = createContextKey('ontology-service.root');
const TRACEPARENT = /^\s*([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?\s*$/;

function parentContextOf(traceparent?: string | null): Context {
  if (!traceparent) return ROOT_CONTEXT;

  const match = TRACEPARENT.exec(traceparent);

  if (!match) return ROOT_CONTEXT;

  const [, version, traceId, spanId, flags, trailing] = match;

  if (version === undefined || traceId === undefined || spanId === undefined || flags === undefined)
    return ROOT_CONTEXT;

  if (version === 'ff' || (version === '00' && trailing !== undefined)) return ROOT_CONTEXT;

  const spanContext: SpanContext = {
    traceId,
    spanId,
    traceFlags: (Number.parseInt(flags, 16) & TraceFlags.SAMPLED) !== 0 ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  };

  return isSpanContextValid(spanContext) ? trace.setSpanContext(ROOT_CONTEXT, spanContext) : ROOT_CONTEXT;
}

export function activeRoot(): LiveSpan<'root'> | undefined {
  return context.active().getValue(ROOT_KEY) as LiveSpan<'root'> | undefined;
}

export interface TraceIds {
  readonly traceId: string;
  readonly rootSpanId: string;
}

export type BodyEnd = 'closed' | 'cancelled' | { readonly failed: unknown };

interface RootAnswer {
  readonly response: Response;
  readonly ids: TraceIds | undefined;
  readonly bodyEnd: Promise<BodyEnd>;
}

export async function rootSpan(
  attributes: StartAttributes<'root'>,
  run: (root: LiveSpan<'root'>, ids: TraceIds | undefined) => Promise<Response>,
  traceparent?: string | null,
): Promise<RootAnswer> {
  const { promise: answer, resolve } = Promise.withResolvers<RootAnswer>();

  const traced = context.with(parentContextOf(traceparent), () =>
    span('root', attributes, (root) =>
      context.with(context.active().setValue(ROOT_KEY, root), () => {
        const active = trace.getActiveSpan();

        const ids =
          active?.isRecording() === true
            ? { traceId: active.spanContext().traceId, rootSpanId: active.spanContext().spanId }
            : undefined;

        return run(root, ids).then((response) => {
          root.set('http.status_code', response.status);

          const { body } = response;

          if (body === null) {
            resolve({ response, ids, bodyEnd: Promise.resolve('closed') });

            return undefined;
          }

          const { promise: bodyEnd, resolve: bodyEnds } = Promise.withResolvers<BodyEnd>();

          return new Promise<void>((spanEnds) => {
            const chunks = span('response.body', {}, () => body);

            const ended = (end: BodyEnd) => {
              bodyEnds(end);

              spanEnds();
            };

            resolve({
              response: new Response(bodyUntilEnd(chunks, ended), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              }),
              ids,
              bodyEnd,
            });
          });
        });
      }),
    ),
  );

  return Promise.race([answer, traced.then(() => answer)]);
}

function bodyUntilEnd(chunks: AsyncIterator<Uint8Array>, ended: (end: BodyEnd) => void): ReadableStream<Uint8Array> {
  let cancelled = false;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await caught(() => chunks.next());

        if (cancelled) return;

        if (!next.ok) {
          controller.error(next.error);

          ended({ failed: next.error });
        } else if (next.value.done === true) {
          controller.close();

          ended('closed');
        } else {
          controller.enqueue(next.value.value);
        }
      },
      cancel(reason) {
        cancelled = true;

        const closing = (async () => chunks.return?.(reason))();

        return caught(() => closing).then(() => {
          ended('cancelled');

          return closing.then(() => undefined);
        });
      },
    },
    { highWaterMark: 0 },
  );
}
