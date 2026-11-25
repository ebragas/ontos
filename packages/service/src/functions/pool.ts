import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { attempt, caught, settle, type AsyncFallible } from '../errors/index.ts';
import { spanOf, type LiveSpan } from '../spans/index.ts';
import { HEAP_LIMIT_MIB, TIME_LIMIT_MS, WAIT_LIMIT_MS } from './limits.ts';
import type { CallTimes, FromWorker, Input, ThrownValue, ToWorker } from './worker.ts';

const MAX_WORKERS = 2;
const WARM_LIMIT_MS = 5_000;
const WORKER_SCRIPT = new URL('./worker.ts', import.meta.url);

interface WarmInput {
  readonly ontologyRid: string;
  readonly bundle: string;
}

interface CallInput extends WarmInput {
  readonly function: string;
  readonly inputs: readonly Input[];
  readonly clientKey?: string;
}

export interface BridgeAnswer {
  readonly status: number;
  readonly headers: [string, string][];
  readonly body: string;
}

export type Bridge = (request: Request, skipTotalCount?: true) => Promise<BridgeAnswer>;

type Failure =
  | { readonly kind: 'threw'; readonly thrown: ThrownValue }
  | { readonly kind: 'objectNotFound'; readonly inputIndex: number }
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'stopped'; readonly cause: unknown; readonly started: boolean };

export class RunFailure extends Error {
  readonly failure: Failure;
  constructor(failure: Failure) {
    super(`The Function call failed: ${failure.kind}.`);

    this.failure = failure;
  }
}

interface Slot {
  readonly worker: Worker;
  key?: string;
  started: boolean;
  warming: boolean;
  stopped: boolean;
  unsettled: boolean;
  onStop?: ((cause: unknown) => void) | undefined;
}

const MAX_WAITING = 32;
const slots = new Set<Slot>();
const idle: Slot[] = [];
const waiting: { readonly key: string; readonly give: (slot: Slot | Error) => void }[] = [];
let live = 0;
let calls = 0;

export async function warmWorker(input: WarmInput): Promise<void> {
  const key = workerKey(input);

  if (hasKey(key) || live >= MAX_WORKERS) return;

  live += 1;

  const created = caught(() => newSlot());

  if (!created.ok) {
    live -= 1;

    return;
  }

  const slot = created.value;

  slot.key = key;
  slot.warming = true;

  const { worker } = slot;

  const warmed = await caught(
    () =>
      new Promise<boolean>((resolve) => {
        let finished = false;

        const done = (ok: boolean) => {
          if (finished) return;

          finished = true;

          clearTimeout(timer);

          worker.off('message', onMessage);

          worker.unref();

          slot.onStop = undefined;

          resolve(ok);
        };

        const timer = setTimeout(() => done(false), WARM_LIMIT_MS);

        const onMessage = (message: FromWorker) => {
          if (message.type === 'warmed') done(true);
          else if (message.type === 'warmFailed') done(false);
        };

        worker.on('message', onMessage);

        slot.onStop = () => done(false);

        const sent = caught(() => worker.postMessage({ type: 'warm', bundle: input.bundle } satisfies ToWorker));

        if (!sent.ok) done(false);
      }),
  );

  slot.warming = false;

  if (warmed.ok && warmed.value && !slot.stopped) {
    release(slot);

    drainIdle();
  } else {
    retire(slot);
  }
}

export async function* callFunction(input: CallInput, bridge: Bridge): AsyncFallible<unknown, RunFailure | Error> {
  const key = workerKey(input);
  const slot = yield* spanOf('worker wait', {}, identity, () => acquire(key, performance.now() + WAIT_LIMIT_MS));
  let failure: RunFailure | Error | undefined;
  let value: unknown;

  try {
    const called = await settle(spanOf('worker call', {}, identity, (call) => runOn(slot, key, input, bridge, call)));

    if (called.ok) value = called.value;
    else {
      failure = called.error;

      if (!(failure instanceof RunFailure) || failure.failure.kind === 'timedOut' || failure.failure.kind === 'stopped')
        retire(slot);
    }
  } finally {
    if (slot.unsettled) retire(slot);

    if (!slot.stopped) release(slot);
  }

  if (failure !== undefined) return yield failure;

  return value;
}

const identity = (failure: RunFailure | Error): unknown => failure;

const MAX_KEY_CACHE = 16;
const keyCache = new Map<string, { readonly bundle: string; readonly key: string }>();

function workerKey(input: WarmInput): string {
  const cached = keyCache.get(input.ontologyRid);

  if (cached !== undefined && cached.bundle === input.bundle) return cached.key;

  const key = createHash('sha256').update(input.ontologyRid).update('\0').update(input.bundle).digest('hex');

  if (cached !== undefined) keyCache.delete(input.ontologyRid);
  else if (keyCache.size >= MAX_KEY_CACHE) {
    const oldest = keyCache.keys().next().value;

    if (oldest !== undefined) keyCache.delete(oldest);
  }

  keyCache.set(input.ontologyRid, { bundle: input.bundle, key });

  return key;
}

async function* acquire(key: string, deadline: number): AsyncFallible<Slot, Error> {
  const taken = caught(() => take(key));

  if (!taken.ok) return yield asError(taken.error);

  let slot = taken.value ?? (yield* wait(key, deadline));

  while (slot.key !== undefined && slot.key !== key) {
    retire(slot);

    slot = yield* wait(key, deadline);
  }

  return slot;
}

const asError = (thrown: unknown): Error => (thrown instanceof Error ? thrown : new Error(String(thrown)));

function hasKey(key: string): boolean {
  for (const slot of slots) if (!slot.stopped && slot.key === key) return true;

  return false;
}

function hasWarming(key: string): boolean {
  for (const slot of slots) if (!slot.stopped && slot.warming && slot.key === key) return true;

  return false;
}

function take(key: string): Slot | undefined {
  const warm = idle.findLast((slot) => slot.key === key);

  if (warm) {
    idle.splice(idle.indexOf(warm), 1);

    return warm;
  }

  if (waiting.length === 0 && hasWarming(key)) return undefined;

  if (live < MAX_WORKERS) {
    const slot = newSlot();

    live += 1;

    return slot;
  }

  return idle.shift();
}

async function* wait(key: string, deadline: number): AsyncFallible<Slot, Error> {
  if (waiting.length >= MAX_WAITING)
    return yield new Error(`The worker pool already has ${MAX_WAITING} callers waiting, so the Function did not run.`);

  const free = yield* attempt(
    () =>
      new Promise<Slot | Error>((resolve) => {
        const entry = {
          key,
          give: (slot: Slot | Error) => {
            clearTimeout(timer);

            resolve(slot);
          },
        };

        const timer = setTimeout(
          () => {
            const index = waiting.indexOf(entry);

            if (index !== -1) waiting.splice(index, 1);

            resolve(new Error(`No worker was free for ${WAIT_LIMIT_MS} ms, so the Function did not run.`));
          },
          Math.max(0, deadline - performance.now()),
        );

        waiting.push(entry);
      }),
    asError,
  );

  if (free instanceof Error) return yield free;

  return free;
}

function release(slot: Slot): void {
  const match = waiting.findIndex((entry) => entry.key === slot.key);

  if (match !== -1) {
    waiting.splice(match, 1)[0]?.give(slot);

    return;
  }

  const index = waiting.findIndex((entry) => !hasWarming(entry.key));

  if (index !== -1) {
    waiting.splice(index, 1)[0]?.give(slot);

    return;
  }

  idle.push(slot);
}

function drainIdle(): void {
  while (idle.length > 0 && waiting.some((entry) => !hasWarming(entry.key))) {
    const free = idle.shift();

    if (free) release(free);
  }
}

function hand(): void {
  const next = waiting.shift();

  if (!next) return;

  const created = caught(() => newSlot());

  if (!created.ok) {
    next.give(asError(created.error));

    return;
  }

  live += 1;

  next.give(created.value);

  drainIdle();
}

function retire(slot: Slot): void {
  if (slot.stopped) return;

  slot.stopped = true;
  slot.warming = false;

  slots.delete(slot);

  void slot.worker.terminate();
}

function newSlot(): Slot {
  const worker = new Worker(WORKER_SCRIPT, { env: {}, resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MIB } });

  worker.unref();

  const slot: Slot = { worker, started: false, warming: false, stopped: false, unsettled: false };

  slots.add(slot);

  worker.on('message', (message: FromWorker) => {
    if (message.type === 'ready') slot.started = true;
  });

  const stop = (cause: unknown) => {
    const { onStop } = slot;

    slot.onStop = undefined;
    slot.stopped = true;
    slot.warming = false;

    slots.delete(slot);

    const at = idle.indexOf(slot);

    if (at !== -1) idle.splice(at, 1);

    onStop?.(cause);
  };

  worker.on('error', stop);

  worker.on('exit', (code) => {
    stop(new Error(`The worker exited with code ${code}.`));

    live -= 1;

    hand();
  });

  return slot;
}

type Ended = { readonly edits: unknown } | RunFailure;

async function* runOn(
  slot: Slot,
  key: string,
  input: CallInput,
  bridge: Bridge,
  workerCall: LiveSpan<'worker call'>,
): AsyncFallible<unknown, RunFailure | Error> {
  const { worker } = slot;
  const call = ++calls;
  const abort = new AbortController();

  const ended = yield* attempt(
    () =>
      new Promise<Ended>((resolve) => {
        const done = (result: Ended) => {
          clearTimeout(timer);

          worker.off('message', onMessage);

          worker.unref();

          slot.onStop = undefined;

          if (!abort.signal.aborted) abort.abort(result instanceof RunFailure ? result : undefined);

          resolve(result);
        };

        const timer = setTimeout(() => done(new RunFailure({ kind: 'timedOut' })), TIME_LIMIT_MS);

        const onMessage = (message: FromWorker) => {
          if (
            message.type === 'ready' ||
            message.type === 'warmed' ||
            message.type === 'warmFailed' ||
            message.call !== call
          )
            return;

          if (message.type === 'fetch') {
            void answer(worker, message, bridge, abort.signal);

            return;
          }

          slot.unsettled = !message.settled;

          recordTimes(workerCall, message.times);

          if (message.type === 'done') done({ edits: message.edits });
          else if (message.type === 'objectNotFound')
            done(new RunFailure({ kind: 'objectNotFound', inputIndex: message.inputIndex }));
          else done(new RunFailure({ kind: 'threw', thrown: message.error }));
        };

        worker.on('message', onMessage);

        slot.onStop = (cause) => done(new RunFailure({ kind: 'stopped', cause, started: slot.started }));

        const warm = slot.key === key;

        const message: ToWorker = {
          type: 'call',
          call,
          ...(warm ? {} : { bundle: input.bundle }),
          function: input.function,
          inputs: input.inputs,
          ontologyRid: input.ontologyRid,
          ...(input.clientKey === undefined ? {} : { clientKey: input.clientKey }),
        };

        const posted = caught(() => worker.postMessage(message));

        if (!posted.ok) {
          done(new RunFailure({ kind: 'stopped', cause: posted.error, started: slot.started }));

          return;
        }

        slot.key = key;
      }),
    asError,
  );

  if (ended instanceof RunFailure) return yield ended;

  return ended.edits;
}

function recordTimes(workerCall: LiveSpan<'worker call'>, { bundleLoad, functionBody }: CallTimes): void {
  if (bundleLoad) workerCall.record('bundle load', bundleLoad);

  if (functionBody) workerCall.record('function body', functionBody);
}

async function answer(
  worker: Worker,
  message: Extract<FromWorker, { type: 'fetch' }>,
  bridge: Bridge,
  signal: AbortSignal,
): Promise<void> {
  const bridged = await caught(async () => {
    const request = new Request(message.url, {
      method: message.method,
      headers: [...message.headers],
      ...(message.body === null ? {} : { body: message.body }),
      signal,
    });

    return await bridge(request, message.skipTotalCount);
  });

  if (signal.aborted) return;

  const reply: BridgeAnswer = bridged.ok ? bridged.value : { status: 500, headers: [], body: '' };
  const toWorker: ToWorker = { type: 'answer', request: message.request, ...reply };

  caught(() => worker.postMessage(toWorker));
}
