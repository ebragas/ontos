import { beforeAll, describe, expect, it } from 'vitest';
import { notesApp } from './apps.test-utils.ts';
import { cli, stubFetch } from './cli.test-utils.ts';
import { localGate, installGate, notesUsers, personEnv, toLocal } from './sql.test-utils.ts';

const local = localGate('production', notesUsers());
const NOTE = 'com.example.notes.Note';
const KEYS = Array.from({ length: 101 }, (_, index) => `n-${String(index + 1).padStart(3, '0')}`);

const run = async (args: readonly string[]) =>
  cli([...args, ...local.flags()], { fetch: globalThis.fetch, env: await personEnv(local.service) });

beforeAll(async () => {
  expect(
    (
      await cli(['publish', ...local.flags()], {
        cwd: notesApp(),
        fetch: stubFetch(toLocal),
        env: local.service.oidcEnv,
      })
    ).stderr,
  ).toBe('');

  await installGate(local.service);

  for (const noteId of KEYS)
    expect(
      (await run(['apply', 'com.example.notes.create-note', '--parameters', JSON.stringify({ noteId, text: noteId })]))
        .stderr,
    ).toBe('');
});

describe('the page size of objects against node.ts', () => {
  it('service/cli#limits: objects returns 100 Objects and nextPageToken by default, --page-token reads the next page, and --page-size asks for up to 10,000', async () => {
    const page = ['objects', NOTE, '--order-by', '{"noteId":"asc"}', '--select', '["noteId"]'];

    type Page = { data: { $primaryKey: string }[]; nextPageToken?: string; totalCount: string };

    const keys = (output: unknown) => (output as Page).data.map((note) => note.$primaryKey);

    const byDefault = await run(page);

    expect(byDefault.stderr).toBe('');
    expect(byDefault.code).toBe(0);

    const first = byDefault.output as Page;

    expect(keys(first)).toEqual(KEYS.slice(0, 100));
    expect(first.nextPageToken).toEqual(expect.any(String));

    const next = await run([...page, '--page-token', first.nextPageToken ?? '']);

    expect(next.code).toBe(0);

    expect(next.output).toEqual({
      data: [
        { noteId: 'n-101', $apiName: NOTE, $objectType: NOTE, $primaryKey: 'n-101', $objectSpecifier: `${NOTE}:n-101` },
      ],
      totalCount: '101',
    });

    const max = await run([...page, '--page-size', '10000']);

    expect(max.stderr).toBe('');
    expect(max.code).toBe(0);

    const all = max.output as Page;

    expect(keys(all)).toEqual(KEYS);
    expect(all.nextPageToken).toBeUndefined();

    const over = await run(['objects', NOTE, '--page-size', '10001']);

    expect(over.code).toBe(1);
    expect(over.error).toEqual({ message: '--page-size is a whole number from 1 to 10000, not 10001.' });
  });
});
