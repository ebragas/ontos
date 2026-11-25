import { describe, expect, it } from 'vitest';
import { buildBundle, type BundleVersion } from './bundle.ts';
import { committedFunctions } from './committed.ts';

const FUNCTIONS: Record<BundleVersion, string[]> = {
  '0.4.0': ['closeAccount'],
  '0.6.3': ['closeAccount', 'probeVersionCheck', 'setRelationship'],
  '0.7.0': ['closeAccount', 'probeVersionCheck', 'setRelationship'],
};

const VERSIONS = Object.keys(FUNCTIONS) as BundleVersion[];

interface Bundle {
  functions: Record<string, (...args: unknown[]) => unknown>;
  createClient: unknown;
}

function committed(version: BundleVersion): string {
  return committedFunctions(version).bundle;
}

async function load(text: string): Promise<Bundle> {
  return (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
  )) as Bundle;
}

describe.each(VERSIONS)('the twin Function bundle of %s', (version) => {
  it('is the output of the bundle script, and 2 runs of the script give the same text', async () => {
    const first = await buildBundle(version);

    const second = await buildBundle(version);

    expect(second).toBe(first);
    expect(first).toBe(committed(version));
  });

  it('holds no import, so it loads from its text alone', () => {
    const text = committed(version);

    expect(text).not.toMatch(/^\s*import[\s{*"']/m);
    expect(text).not.toMatch(/^\s*export\s.*\sfrom\s/m);
    expect(text).not.toMatch(/\brequire\(/);
  });

  it('exports createClient and 1 Function for each discovered Function of its version', async () => {
    const bundle = await load(committed(version));

    expect(Object.keys(bundle).sort()).toEqual(['createClient', 'functions']);
    expect(typeof bundle.createClient).toBe('function');
    expect(Object.keys(bundle.functions).sort()).toEqual(FUNCTIONS[version]);

    const discovered = committedFunctions(version).discovered.map((f) => f.locator.typescript?.functionName ?? '');

    expect(discovered.sort()).toEqual(FUNCTIONS[version]);
  });

  it('runs closeAccount, whose UserFacingError keeps its name', async () => {
    const { functions } = await load(committed(version));

    const account = { $apiName: 'com.example.twin.Account', $primaryKey: 'acc-1', accountId: 'acc-1' };

    await expect(functions.closeAccount?.({}, account, 'test-throw-user')).rejects.toMatchObject({
      name: 'UserFacingError',
      message: 'test user-facing error',
    });
  });
});

describe.each(['0.6.3', '0.7.0'] as const)('the twin Function bundle of %s', (version) => {
  it('runs setRelationship, which returns 1 updateObject edit', async () => {
    const { functions } = await load(committed(version));

    const probe = { $apiName: 'com.example.twin.StructProbe', $primaryKey: 'sp-1', probeId: 'sp-1' };
    const relationship = { label: 'a', since: '2026-01-02' };

    expect(functions.setRelationship?.({}, probe, relationship, 'full')).toEqual([
      { type: 'updateObject', obj: probe, properties: { relationship: { label: 'a', since: '2026-01-02' } } },
    ]);
  });
});
