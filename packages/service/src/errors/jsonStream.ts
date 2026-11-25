import { ApiError } from './apiError.ts';
import { caught, settle, step, type AsyncFallible, type FallibleStream } from './fallible.ts';

const BATCH_ITEMS = 64;
const BATCH_CHARS = 16_384;

export type StreamFailure = ApiError | { readonly error: unknown };

export async function* jsonStream<E extends StreamFailure>(
  head: () => Readonly<Record<string, unknown>>,
  field: string,
  items: FallibleStream<unknown, E>,
  tail: () => Readonly<Record<string, unknown>>,
): AsyncFallible<ReadableStream<Uint8Array>, E> {
  const encoder = new TextEncoder();
  let next = yield* step(items);
  let first = true;

  const openPrefix = () => {
    const open = JSON.stringify(head()).slice(0, -1);

    return `${open}${open === '{' ? '' : ','}${JSON.stringify(field)}:[`;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const pulled = await caught(async () => {
        if (next.done) {
          const close = JSON.stringify(tail()).slice(1);
          const prefix = first ? openPrefix() : '';

          first = false;

          controller.enqueue(encoder.encode(`${prefix}]${close === '}' ? '' : ','}${close}`));

          controller.close();

          return undefined;
        }

        const parts: string[] = [];
        let chars = 0;

        if (first) {
          const prefix = openPrefix();

          parts.push(prefix);

          chars += prefix.length;
        }

        for (let count = 0; !next.done && (count === 0 || (count < BATCH_ITEMS && chars < BATCH_CHARS)); count += 1) {
          const serialized = `${first ? '' : ','}${JSON.stringify(next.value)}`;

          first = false;

          parts.push(serialized);

          chars += serialized.length;

          const stepped = await settle(step(items));

          if (!stepped.ok) return stepped.error;

          next = stepped.value;
        }

        controller.enqueue(encoder.encode(parts.join('')));

        return undefined;
      });

      const failure = pulled.ok ? pulled.value : { error: pulled.error };

      if (failure === undefined) return;

      const error = failure instanceof ApiError ? failure : failure.error;

      console.log(JSON.stringify({ stack: error instanceof Error ? (error.stack ?? String(error)) : String(error) }));

      await caught(() => items.return(undefined));

      controller.error(error);
    },
    async cancel() {
      await caught(() => items.return(undefined));
    },
  });
}
