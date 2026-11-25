import { describe, expect, it } from 'vitest';
import { NOTES_ONTOLOGY, notesApp } from './apps.test-utils.ts';
import { cli, stubFetch } from './cli.test-utils.ts';
import { installGate, localGate, notesUsers, toLocal } from './sql.test-utils.ts';

const local = localGate('production', notesUsers({ user_01HANN: 'member', user_01HBEN: 'member' }));
const NOTE = 'com.example.notes.Note';

const POLICY = `    datasources: [{
        type: "dataset",
        objectSecurityPolicy: {
            name: "own",
            granularPolicy: { type: "comparison", comparison: { left: { type: "property", property: "ownerId" }, operator: "EQUAL", right: { type: "userProperty", userProperty: { type: "userId", userId: {} } } } },
        },
    }],
`;

const OWNED = NOTES_ONTOLOGY.replace(
  '        text: { type: "string", description: "The words of the note." },\n',
  '        text: { type: "string", description: "The words of the note." },\n        ownerId: { type: "string", description: "The owner of the note." },\n',
)
  .replace(
    'text: { description: "The words." } }',
    'text: { description: "The words." }, ownerId: { description: "The owner." } }',
  )
  .replace('    editsEnabled: true,\n', '    editsEnabled: true,\n    editsHistoryConfig: { enabled: true },\n')
  .replace('    includeEmptyBackingDatasource: true,\n', POLICY);

describe('history against node.ts with an object security policy', () => {
  it('ontology/object-edits/edit-history#security: history gives each person the entries of their own Notes only, and the key of a hidden Note gives no entry', async () => {
    expect(OWNED).toContain('objectSecurityPolicy');
    expect(OWNED).toContain('ownerId: { type: "string", description: "The owner of the note." }');

    const published = await cli(['publish', ...local.flags()], {
      cwd: notesApp({ 'ontology/src/ontology.mts': OWNED }),
      fetch: stubFetch(toLocal),
      env: local.service.oidcEnv,
    });

    expect(published.stderr).toBe('');

    await installGate(local.service);

    const as = async (sub: string) => ({ ONTOLOGY_TOKEN: await local.service.issuer.workos({ sub }) });

    const [ann, ben] = [await as('user_01HANN'), await as('user_01HBEN')];

    for (const [noteId, ownerId, env] of [
      ['n-1', 'user_01HANN', ann],
      ['n-2', 'user_01HBEN', ben],
    ] as const) {
      const created = await cli(
        [
          'apply',
          'com.example.notes.create-note',
          '--parameters',
          JSON.stringify({ noteId, text: noteId, ownerId }),
          ...local.flags(),
        ],
        { fetch: globalThis.fetch, env },
      );

      expect(created.stderr).toBe('');
    }

    const keys = async (env: { ONTOLOGY_TOKEN: string }, ...key: string[]) => {
      const history = await cli(['history', NOTE, ...key, ...local.flags()], { fetch: globalThis.fetch, env });

      expect(history.stderr).toBe('');

      const page = history.output as {
        data: { objectPrimaryKey: { noteId: { value: string } } }[];
        totalCount: number;
      };

      return { keys: page.data.map((entry) => entry.objectPrimaryKey.noteId.value), totalCount: page.totalCount };
    };

    expect(await keys(ann)).toEqual({ keys: ['n-1'], totalCount: 1 });

    expect(await keys(ben)).toEqual({ keys: ['n-2'], totalCount: 1 });

    expect(await keys(ann, 'n-2')).toEqual({ keys: [], totalCount: 0 });

    expect(await keys(ann, 'n-none')).toEqual({ keys: [], totalCount: 0 });
  });
});
