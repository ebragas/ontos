import { describe, expect, it } from 'vitest';
import { cli, STUB, stubConfig, stubFetch } from './cli.test-utils.ts';
import { serviceFetch } from './serviceFetch.ts';

const NO_SLEEP = new RangeError('no sleep');
const sleep = (): Promise<void> => Promise.reject(NO_SLEEP);
const unreachable = (): Promise<never> => Promise.reject(new TypeError('fetch failed'));

describe('service/cli#output', () => {
  it('rejects a read with the rejection of the wait, as it is', async () => {
    const rejected = await serviceFetch({ fetch: unreachable, sleep })(`${STUB}/api/v2/ontologies`).catch(
      (error: unknown) => error,
    );

    expect(rejected).toBe(NO_SLEEP);
  });

  it('gives the CLI a message from the rejection of the wait', async () => {
    const fetch = stubFetch(({ url }) => (url.includes('/api/v2/ontologies') ? unreachable() : undefined), stubConfig);

    const result = await cli(['objects', 'com.example.twin.Account', '--app', 'twin', '--url', STUB], {
      env: { ONTOLOGY_TOKEN: 't' },
      fetch,
      sleep,
    });

    expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toEqual({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining('no sleep'),
    });
  });
});
