import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keptAnswers, workosUnavailable, type Failure, type Limit } from './kept.ts';
import { workosPermissions } from './users.ts';
import { type AsyncFallible } from '../errors/index.ts';
import { given, promised, rejecting } from '../service.test-utils.ts';
import { ORGANIZATION, PERSON } from '../tokens.test-utils.ts';
import { STUB_PERSON, STUB_WORKOS_KEY, stubWorkos } from '../workos.test-utils.ts';

const noopLimit = (): Limit => ({ signal: new AbortController().signal, start: () => undefined });

async function* failing(error: Failure): AsyncFallible<never, Failure> {
  return yield error;
}

describe('keptAnswers stale-while-revalidate', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }));

  afterEach(() => vi.useRealTimers());

  it('serves a stale-but-usable entry at once while running 1 single-flight background refresh', async () => {
    const cache = keptAnswers<string>();
    let calls = 0;
    let release!: () => void;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    expect(
      await rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return given('v1');
          },
          noopLimit(),
        ),
      ),
    ).toBe('v1');

    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);

    const slowRead = () =>
      (async function* (): AsyncFallible<string, Failure> {
        calls += 1;

        await held;

        return yield* given('v2');
      })();

    const [a, b, c] = await Promise.all([
      rejecting(cache.get('k', slowRead, noopLimit())),
      rejecting(cache.get('k', slowRead, noopLimit())),
      rejecting(cache.get('k', slowRead, noopLimit())),
    ]);

    expect([a, b, c]).toEqual(['v1', 'v1', 'v1']);
    expect(calls).toBe(2);

    release();

    await vi.advanceTimersByTimeAsync(0);

    expect(await rejecting(cache.get('k', slowRead, noopLimit()))).toBe('v2');

    expect(calls).toBe(2);
  });

  it('absorbs background refresh failures without overwriting the usable entry and evicts past usableMs', async () => {
    const cache = keptAnswers<string>();
    let calls = 0;

    expect(
      await rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return given('v1');
          },
          noopLimit(),
        ),
      ),
    ).toBe('v1');

    await vi.advanceTimersByTimeAsync(120_000);

    expect(
      await rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return failing(workosUnavailable());
          },
          noopLimit(),
        ),
      ),
    ).toBe('v1');

    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toBe(2);

    await vi.advanceTimersByTimeAsync(180_000);

    expect(
      await rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return failing(workosUnavailable());
          },
          noopLimit(),
        ),
      ),
    ).toBe('v1');

    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toBe(3);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(
      rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return failing(workosUnavailable());
          },
          noopLimit(),
        ),
      ),
    ).rejects.toMatchObject({
      status: 503,
      errorName: 'OntologyService:WorkosUnavailable',
    });

    expect(calls).toBe(4);
    expect(cache.size).toBe(0);
  });

  it('coalesces a blocking caller past usableMs onto an already in-flight background refresh', async () => {
    const cache = keptAnswers<string>();
    let calls = 0;
    let release!: () => void;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    expect(
      await rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return given('v1');
          },
          noopLimit(),
        ),
      ),
    ).toBe('v1');

    await vi.advanceTimersByTimeAsync(299_000);

    const refresh = () =>
      (async function* (): AsyncFallible<string, Failure> {
        calls += 1;

        await held;

        return yield* given('v2');
      })();

    expect(await rejecting(cache.get('k', refresh, noopLimit()))).toBe('v1');

    expect(calls).toBe(2);

    await vi.advanceTimersByTimeAsync(2_000);

    const pending = rejecting(cache.get('k', refresh, noopLimit()));

    expect(calls).toBe(2);

    release();

    expect(await pending).toBe('v2');

    expect(calls).toBe(2);
  });

  it('does not serve stale via SWR when fallback returns false', async () => {
    const cache = keptAnswers<string>({ fallback: (value) => value !== 'no-stale' });
    let calls = 0;

    expect(
      await rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return given('no-stale');
          },
          noopLimit(),
        ),
      ),
    ).toBe('no-stale');

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(
      rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return failing(workosUnavailable());
          },
          noopLimit(),
        ),
      ),
    ).rejects.toMatchObject({
      status: 503,
      errorName: 'OntologyService:WorkosUnavailable',
    });

    expect(calls).toBe(2);
  });

  it('honors custom freshMs and usableMs bounds, including eviction past 600s', async () => {
    const cache = keptAnswers<string>({ freshMs: 300_000, usableMs: 600_000 });
    let calls = 0;

    expect(
      await rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return given('v1');
          },
          noopLimit(),
        ),
      ),
    ).toBe('v1');

    await vi.advanceTimersByTimeAsync(299_000);

    expect(
      await rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return given('v2');
          },
          noopLimit(),
        ),
      ),
    ).toBe('v1');

    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(
      await rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return failing(workosUnavailable());
          },
          noopLimit(),
        ),
      ),
    ).toBe('v1');

    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toBe(2);

    await vi.advanceTimersByTimeAsync(300_000);

    expect(
      await rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return failing(workosUnavailable());
          },
          noopLimit(),
        ),
      ),
    ).toBe('v1');

    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toBe(3);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(
      rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return failing(workosUnavailable());
          },
          noopLimit(),
        ),
      ),
    ).rejects.toMatchObject({
      status: 503,
      errorName: 'OntologyService:WorkosUnavailable',
    });

    expect(calls).toBe(4);
    expect(cache.size).toBe(0);

    expect(
      await rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return given('v2');
          },
          noopLimit(),
        ),
      ),
    ).toBe('v2');

    await vi.advanceTimersByTimeAsync(300_000);

    expect(
      await rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return given('v3');
          },
          noopLimit(),
        ),
      ),
    ).toBe('v2');

    await vi.advanceTimersByTimeAsync(0);

    expect(
      await rejecting(
        cache.get(
          'k',
          () => {
            calls += 1;

            return given('v4');
          },
          noopLimit(),
        ),
      ),
    ).toBe('v3');

    expect(calls).toBe(6);
  });

  it('notifies onBackground once per SWR refresh with a non-rejecting promise that settles on success and failure', async () => {
    const pending: Promise<void>[] = [];
    const cache = keptAnswers<string>({ onBackground: (promise) => void pending.push(promise) });

    expect(await rejecting(cache.get('k', () => given('v1'), noopLimit()))).toBe('v1');

    expect(pending).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await rejecting(cache.get('k', () => given('v2'), noopLimit()))).toBe('v1');

    expect(pending).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);

    let release!: () => void;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow = () =>
      (async function* (): AsyncFallible<string, Failure> {
        await held;

        return yield* given('v2');
      })();

    const [first, second] = await Promise.all([
      rejecting(cache.get('k', slow, noopLimit())),
      rejecting(cache.get('k', slow, noopLimit())),
    ]);

    expect([first, second]).toEqual(['v1', 'v1']);
    expect(pending).toHaveLength(1);

    let settled = false;

    void pending[0]?.then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(false);

    release();

    await expect(pending[0]).resolves.toBeUndefined();

    expect(await rejecting(cache.get('k', slow, noopLimit()))).toBe('v2');

    await vi.advanceTimersByTimeAsync(60_000);

    expect(await rejecting(cache.get('k', () => failing(workosUnavailable()), noopLimit()))).toBe('v2');

    expect(pending).toHaveLength(2);

    await expect(pending[1]).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);

    const throwing = () =>
      (async function* (): AsyncFallible<string, Failure> {
        await Promise.reject(new Error('boom'));

        return yield* given('v2');
      })();

    expect(await rejecting(cache.get('k', throwing, noopLimit()))).toBe('v2');

    expect(pending).toHaveLength(3);

    await expect(pending[2]).resolves.toBeUndefined();
  });

  it('evicts oldest entries once the cache exceeds maxEntries and enforces the 1,000-entry default cap', async () => {
    const small = keptAnswers<string>({ maxEntries: 2 });
    let reads = 0;

    const read = (value: string) => () => {
      reads += 1;

      return given(value);
    };

    expect(await rejecting(small.get('a', read('va'), noopLimit()))).toBe('va');

    expect(await rejecting(small.get('b', read('vb'), noopLimit()))).toBe('vb');

    expect(await rejecting(small.get('c', read('vc'), noopLimit()))).toBe('vc');

    expect(small.size).toBe(2);
    expect(reads).toBe(3);

    expect(await rejecting(small.get('b', read('vb2'), noopLimit()))).toBe('vb');

    expect(reads).toBe(3);

    expect(await rejecting(small.get('a', read('va2'), noopLimit()))).toBe('va2');

    expect(reads).toBe(4);
    expect(small.size).toBe(2);

    const bounded = keptAnswers<number>();

    for (let index = 0; index < 1_005; index += 1)
      await rejecting(bounded.get(`k-${index}`, () => given(index), noopLimit()));

    expect(bounded.size).toBe(1_000);
  });
});

describe('workosPermissions decoupled role TTL', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }));

  afterEach(() => vi.useRealTimers());

  it('keeps role fresh past 60s when membership refreshes in the background, and refreshes role at 300s', async () => {
    const stub = stubWorkos(
      [STUB_PERSON],
      [{ user_id: PERSON, organization_id: ORGANIZATION, status: 'active', roles: ['member'] }],
      { roles: { [ORGANIZATION]: { member: ['jobsite:read'] } } },
    );

    const permissions = promised(workosPermissions(STUB_WORKOS_KEY, 'https://api.workos.com', stub.fetch));
    const membershipPath = `/user_management/organization_memberships?user_id=${PERSON}&organization_id=${ORGANIZATION}`;
    const rolePath = `/authorization/organizations/${ORGANIZATION}/roles/member`;

    expect(await permissions(PERSON, ORGANIZATION)).toEqual(['jobsite:read']);

    expect(stub.requests).toEqual([membershipPath, rolePath]);

    stub.setRole(ORGANIZATION, 'member', ['jobsite:read', 'jobsite:write']);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(await permissions(PERSON, ORGANIZATION)).toEqual(['jobsite:read']);

    await vi.advanceTimersByTimeAsync(0);

    expect(stub.requests).toEqual([membershipPath, rolePath, membershipPath]);

    await vi.advanceTimersByTimeAsync(239_000);

    expect(await permissions(PERSON, ORGANIZATION)).toEqual(['jobsite:read']);

    await vi.advanceTimersByTimeAsync(0);

    expect(stub.requests.filter((path) => path === rolePath)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(await permissions(PERSON, ORGANIZATION)).toEqual(['jobsite:read']);

    await vi.advanceTimersByTimeAsync(0);

    expect(stub.requests.filter((path) => path === rolePath)).toHaveLength(2);

    expect(await permissions(PERSON, ORGANIZATION)).toEqual(['jobsite:read', 'jobsite:write']);
  });
});
