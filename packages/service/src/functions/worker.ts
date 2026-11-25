import { createHook } from 'node:async_hooks';
import { parentPort } from 'node:worker_threads';

export type ToWorker =
  | {
      readonly type: 'warm';
      readonly bundle: string;
    }
  | {
      readonly type: 'call';
      readonly call: number;
      readonly bundle?: string;
      readonly function: string;
      readonly inputs: readonly Input[];
      readonly ontologyRid: string;
      readonly clientKey?: string;
    }
  | {
      readonly type: 'answer';
      readonly request: number;
      readonly status: number;
      readonly headers: [string, string][];
      readonly body: string;
    };

interface Interval {
  readonly start: number;
  readonly end: number;
}

export interface CallTimes {
  bundleLoad?: Interval;
  functionBody?: Interval;
}

export type FromWorker =
  | { readonly type: 'ready' }
  | { readonly type: 'warmed' }
  | { readonly type: 'warmFailed' }
  | {
      readonly type: 'done';
      readonly call: number;
      readonly edits: unknown;
      readonly settled: boolean;
      readonly times: CallTimes;
    }
  | {
      readonly type: 'failed';
      readonly call: number;
      readonly error: ThrownValue;
      readonly settled: boolean;
      readonly times: CallTimes;
    }
  | {
      readonly type: 'objectNotFound';
      readonly call: number;
      readonly inputIndex: number;
      readonly settled: boolean;
      readonly times: CallTimes;
    }
  | {
      readonly type: 'fetch';
      readonly call: number;
      readonly request: number;
      readonly url: string;
      readonly method: string;
      readonly headers: [string, string][];
      readonly body: string | null;
      readonly skipTotalCount?: true;
    };

export type Input =
  | { readonly value: unknown }
  | { readonly objectType: string; readonly keyProperty: string; readonly primaryKey: string }
  | { readonly objectType: string; readonly keyProperty: string; readonly primaryKeys: readonly string[] };

export interface ThrownValue {
  readonly error: boolean;
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
  readonly parameterId?: string;
}

type Call = Extract<ToWorker, { type: 'call' }>;

type Answer = Extract<ToWorker, { type: 'answer' }>;

interface Bundle {
  readonly functions: Readonly<Record<string, unknown>>;
  readonly createClient: (...args: unknown[]) => unknown;
}

const BASE_URL = 'https://ontology-service.invalid';
const NO_BODY = new Set([101, 204, 205, 304]);
const BUNDLE_NAME = 'function-bundle.js';
const DATA_URL = /data:text\/javascript;base64,[\w+/=]+/g;

const port = parentPort;

if (!port) throw new Error('The worker script runs only in a worker thread.');

Object.defineProperty(globalThis, 'fetch', {
  value: () => Promise.reject(new Error('A V1 Function cannot call fetch.')),
  writable: false,
  configurable: false,
});

interface Timer {
  readonly _destroyed: boolean;
}

const timers = new Set<Timer>();

createHook({
  init: (_id, type, _trigger, resource) => {
    if (type === 'Timeout' || type === 'Immediate') timers.add(resource as Timer);
  },
  trackPromises: false,
}).enable();

function timerLeft(): boolean {
  for (const timer of timers) if (timer._destroyed) timers.delete(timer);

  return timers.size > 0;
}

const MAX_CLIENTS = 16;

let loaded: Promise<Bundle> | undefined;
const clients = new Map<string, OsdkClient>();
const answers = new Map<number, (answer: Answer) => void>();
let requests = 0;
let current: number | undefined;
let loadingInputs = false;

port.on('message', (message: ToWorker) => {
  if (message.type === 'answer') {
    answers.get(message.request)?.(message);

    answers.delete(message.request);

    return;
  }

  if (message.type === 'warm') {
    void warm(message.bundle);

    return;
  }

  void run(message);
});

post({ type: 'ready' });

const clock = (): number => performance.timeOrigin + performance.now();

async function warm(bundle: string): Promise<void> {
  try {
    await load(bundle);
  } catch {
    post({ type: 'warmFailed' });

    return;
  }

  await new Promise((resolve) => setImmediate(resolve));

  const settled =
    answers.size === 0 &&
    !timerLeft() &&
    process.getActiveResourcesInfo().every((resource) => resource === 'MessagePort');

  post(settled ? { type: 'warmed' } : { type: 'warmFailed' });
}

async function run(call: Call): Promise<void> {
  current = call.call;

  let outcome:
    | { readonly type: 'done'; readonly edits: unknown }
    | { readonly type: 'failed'; readonly error: ThrownValue }
    | { readonly type: 'objectNotFound'; readonly inputIndex: number };

  const times: CallTimes = {};

  try {
    const bundle = await load(call.bundle, times);

    const fn = Object.hasOwn(bundle.functions, call.function) ? bundle.functions[call.function] : undefined;

    if (typeof fn !== 'function') throw new Error(`The Function bundle has no Function ${call.function}.`);

    const client = clientFor(bundle, call);

    let inputs: unknown[];

    loadingInputs = true;

    try {
      inputs = await loadInputs(client, call.inputs);
    } finally {
      loadingInputs = false;
    }

    const start = clock();
    let edits: unknown;

    try {
      edits = await (fn as (...args: unknown[]) => unknown)(client, ...inputs);
    } finally {
      times.functionBody = { start, end: clock() };
    }

    outcome = { type: 'done', edits: plain(edits ?? null) };
  } catch (error) {
    outcome =
      error instanceof MissingObject
        ? { type: 'objectNotFound', inputIndex: error.inputIndex }
        : { type: 'failed', error: thrown(error) };
  }

  await new Promise((resolve) => setImmediate(resolve));

  current = undefined;

  const settled =
    answers.size === 0 &&
    !timerLeft() &&
    process.getActiveResourcesInfo().every((resource) => resource === 'MessagePort');

  post({ ...outcome, call: call.call, settled, times });
}

function plain(value: unknown): unknown {
  if (typeof value === 'bigint') throw new TypeError('An edit holds a BigInt, which has no JSON form.');

  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (typeof value !== 'object' || value === null) return value;

  if (typeof (value as { toJSON?: unknown }).toJSON === 'function')
    return plain((value as { toJSON: () => unknown }).toJSON());

  if (Array.isArray(value)) return value.map((element) => plain(element) ?? null);

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, element]) => {
      const copy = plain(element);

      return copy === undefined ? [] : [[key, copy]];
    }),
  );
}

type OsdkClient = (objectType: { type: 'object'; apiName: string }) => {
  where: (clause: Record<string, { $in: readonly string[] }>) => {
    fetchPage: (options: { $pageSize: number }) => Promise<{ data: unknown[] }>;
  };
};

const MAX_PAGE_SIZE = 10_000;

class MissingObject extends Error {
  readonly inputIndex: number;
  constructor(inputIndex: number) {
    super(`The Object input ${inputIndex} names an Object that does not exist.`);

    this.inputIndex = inputIndex;
  }
}

function loadInputs(client: OsdkClient, inputs: readonly Input[]): Promise<unknown[]> {
  return Promise.all(
    inputs.map(async (input, index) => {
      if ('value' in input) return input.value;

      const keys = 'primaryKey' in input ? [input.primaryKey] : input.primaryKeys;
      const unique = [...new Set(keys)];
      const objects = new Map<unknown, unknown>();

      for (let start = 0; start < unique.length; start += MAX_PAGE_SIZE) {
        const page = unique.slice(start, start + MAX_PAGE_SIZE);

        const { data } = await client({ type: 'object', apiName: input.objectType })
          .where({ [input.keyProperty]: { $in: page } })
          .fetchPage({ $pageSize: page.length });

        for (const object of data) objects.set((object as { $primaryKey: unknown }).$primaryKey, object);
      }

      const loaded = keys.map((key) => objects.get(key));

      if (loaded.some((object) => object === undefined)) throw new MissingObject(index);

      return 'primaryKey' in input ? loaded[0] : loaded;
    }),
  );
}

function clientFor(bundle: Bundle, call: Call): OsdkClient {
  const create = () =>
    bundle.createClient(BASE_URL, call.ontologyRid, () => Promise.resolve('function'), {}, clientFetch) as OsdkClient;

  const key = call.clientKey;

  if (key === undefined) return create();

  const cached = clients.get(key);

  if (cached !== undefined) {
    clients.delete(key);

    clients.set(key, cached);

    return cached;
  }

  const created = create();

  if (clients.size >= MAX_CLIENTS) {
    const oldest = clients.keys().next().value;

    if (oldest !== undefined) clients.delete(oldest);
  }

  clients.set(key, created);

  return created;
}

async function load(bundle: string | undefined, times?: CallTimes): Promise<Bundle> {
  if (loaded) return loaded;

  if (bundle === undefined) throw new Error('The worker has not loaded a bundle.');

  const text = `${bundle}\n//# sourceURL=${BUNDLE_NAME}`;
  const start = clock();

  loaded = import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`) as Promise<Bundle>;

  try {
    return await loaded;
  } catch (error) {
    loaded = undefined;

    throw error;
  } finally {
    if (times) times.bundleLoad = { start, end: clock() };
  }
}

async function clientFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const call = current;

  if (call === undefined) throw new Error("A request of the Function's client came after the end of its call.");

  const request = new Request(input, init);

  const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.text();

  const id = ++requests;

  const answer = await new Promise<Answer>((resolve) => {
    answers.set(id, resolve);

    post({
      type: 'fetch',
      call,
      request: id,
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body,
      ...(loadingInputs ? { skipTotalCount: true } : {}),
    });
  });

  return new Response(NO_BODY.has(answer.status) ? null : answer.body, {
    status: answer.status,
    headers: [...answer.headers],
  });
}

function thrown(value: unknown): ThrownValue {
  const named = (text: string) => text.replaceAll(DATA_URL, BUNDLE_NAME);

  if (value instanceof Error) {
    const parameterId = Object.hasOwn(value, 'parameterId')
      ? (value as { parameterId?: unknown }).parameterId
      : undefined;

    return {
      error: true,
      name: value.name,
      message: named(value.message),
      ...(value.stack ? { stack: named(value.stack) } : {}),
      ...(typeof parameterId === 'string' ? { parameterId } : {}),
    };
  }

  return { error: false, message: named(String(value)) };
}

function post(message: FromWorker): void {
  port?.postMessage(message);
}
