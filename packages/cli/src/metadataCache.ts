import { createHash } from 'node:crypto';
import type { ListOntologiesV2Response } from '@osdk/foundry.ontologies';
import { shared, type CliError } from './cliError.ts';
import { failureOf } from './errors.ts';
import { attempt, settle, type AsyncFallible, type Result } from './fallible.ts';

const MAX_KEPT = 64;

interface Kept {
  readonly origin: string;
  readonly body: ArrayBuffer;
  readonly headers: Headers;
}

const kept = new Map<string, Kept>();

const KEPT_PATH =
  /^\/api\/(?:ontology-service\/v1\/client-config|v2\/ontologies\/[^/]+\/(?:fullMetadata|objectTypes\/[^/]+\/fullMetadata|actionTypes\/[^/]+))$/;

const rejection = (error: unknown): unknown => error;

function cacheKeyOf(url: URL, request: Request | undefined, init: RequestInit | undefined): string {
  const headers = init?.headers !== undefined ? new Headers(init.headers) : request?.headers;
  const authorization = headers?.get('authorization') ?? '';
  const tokenHash = createHash('sha256').update(authorization).digest('hex');

  return `${url.href}\0${tokenHash}`;
}

function readKept(key: string): Kept | undefined {
  const hit = kept.get(key);

  if (!hit) return undefined;

  kept.delete(key);

  kept.set(key, hit);

  return hit;
}

function writeKept(key: string, entry: Kept): void {
  kept.delete(key);

  if (kept.size >= MAX_KEPT) {
    const oldest = kept.keys().next().value;

    if (oldest !== undefined) kept.delete(oldest);
  }

  kept.set(key, entry);
}

async function* answer(
  fetch: typeof globalThis.fetch,
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
): AsyncFallible<Response, unknown> {
  const request = input instanceof Request ? input : undefined;
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  const url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input);

  if (method !== 'GET' || !KEPT_PATH.test(url.pathname)) return yield* attempt(() => fetch(input, init), rejection);

  const key = cacheKeyOf(url, request, init);
  const hit = readKept(key);

  if (hit) return new Response(hit.body, { status: 200, headers: hit.headers });

  const response = yield* attempt(() => fetch(input, init), rejection);

  if (response.status === 200)
    writeKept(key, {
      origin: url.origin,
      body: yield* attempt(() => response.clone().arrayBuffer(), rejection),
      headers: new Headers(response.headers),
    });

  return response;
}

export function metadataFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const answered = await settle(answer(fetch, input, init));

    // oxlint-disable-next-line fallible/no-throw -- D1: the stock OSDK client reads the rejection of the typeof fetch that it calls.
    if (!answered.ok) throw answered.error;

    return answered.value;
  };
}

type KeptList = { readonly token: string; readonly list: Promise<Result<ListOntologiesV2Response, CliError>> };

const ontologyLists = new Map<string, KeptList>();

export async function* keptOntologies(
  url: string,
  token: string,
  list: () => Promise<ListOntologiesV2Response>,
): AsyncFallible<ListOntologiesV2Response, CliError> {
  const { origin } = new URL(url);
  const held = ontologyLists.get(origin);

  if (held?.token === token) return yield* shared(held.list);

  const entry: KeptList = { token, list: settle(attempt(list, failureOf)) };

  ontologyLists.delete(origin);

  if (ontologyLists.size >= MAX_KEPT) {
    const oldest = ontologyLists.keys().next().value;

    if (oldest !== undefined) ontologyLists.delete(oldest);
  }

  ontologyLists.set(origin, entry);

  void entry.list.then((result) => {
    if (!result.ok && ontologyLists.get(origin) === entry) ontologyLists.delete(origin);
  });

  return yield* shared(entry.list);
}

export function dropMetadata(url: string): void {
  const { origin } = new URL(url);

  for (const [key, entry] of kept) if (entry.origin === origin) kept.delete(key);

  ontologyLists.delete(origin);
}

export function resetMetadata(): void {
  kept.clear();

  ontologyLists.clear();
}
