import { describe, expect, it } from 'vitest';
import { workosUsers } from '../../../packages/service/src/auth/index.ts';
import { STUB_WORKOS_KEY, stubWorkos } from '../../../packages/service/src/workos.test-utils.ts';
import { ORGANIZATION, STUB_PERSON } from '../../../tools/packaging/testService.ts';
import { NOTES_GRANTS, NOTES_ONTOLOGY, notesApp } from './apps.test-utils.ts';
import { cli, stubFetch } from './cli.test-utils.ts';
import { localGate, installGate, personEnv, toLocal } from './sql.test-utils.ts';

const FORMER = 'user_01HFORMER';

const workos = stubWorkos(
  [STUB_PERSON, { id: FORMER, email: 'former@example.com', first_name: 'Flo', last_name: 'Former' }],
  [STUB_PERSON.id, FORMER].map((id) => ({
    user_id: id,
    organization_id: ORGANIZATION,
    status: 'active' as const,
    organization_name: 'Test Organization',
    roles: ['member'],
  })),
  { roles: { [ORGANIZATION]: (JSON.parse(NOTES_GRANTS) as { defaultRoles: Record<string, string[]> }).defaultRoles } },
);

const local = localGate('production', workosUsers(STUB_WORKOS_KEY, { fetch: workos.fetch }));
const NOTE = 'com.example.notes.Note';

const WITH_HISTORY = NOTES_ONTOLOGY.replace(
  '    editsEnabled: true,\n',
  '    editsEnabled: true,\n    editsHistoryConfig: { enabled: true },\n',
);

describe('aggregate and history against node.ts', () => {
  it('service/testing#test-kinds, service/cli#commands: aggregate counts the Objects, and history reads the edits of 1 Object, from the service from node.ts', async () => {
    expect(WITH_HISTORY).not.toBe(NOTES_ONTOLOGY);

    const published = await cli(['publish', ...local.flags()], {
      cwd: notesApp({ 'ontology/src/ontology.mts': WITH_HISTORY }),
      fetch: stubFetch(toLocal),
      env: local.service.oidcEnv,
    });

    expect(published.stderr).toBe('');

    await installGate(local.service);

    const env = await personEnv(local.service);

    const formerMember = { ONTOLOGY_TOKEN: await local.service.issuer.workos({ sub: FORMER }) };

    const appliedByFormerMember = await cli(
      [
        'apply',
        'com.example.notes.create-note',
        '--parameters',
        JSON.stringify({ noteId: 'n-1', text: 'One' }),
        ...local.flags(),
      ],
      { fetch: globalThis.fetch, env: formerMember },
    );

    expect(appliedByFormerMember.stderr).toBe('');

    workos.memberships.splice(
      workos.memberships.findIndex((membership) => membership.user_id === FORMER),
      1,
    );

    const created = await cli(
      [
        'apply',
        'com.example.notes.create-note',
        '--parameters',
        JSON.stringify({ noteId: 'n-2', text: 'Two' }),
        ...local.flags(),
      ],
      { fetch: globalThis.fetch, env },
    );

    expect(created.stderr).toBe('');

    const counted = await cli(['aggregate', NOTE, '--select', '{"$count":"unordered"}', ...local.flags()], {
      fetch: globalThis.fetch,
      env,
    });

    expect(counted.stderr).toBe('');
    expect(counted.output).toEqual({ $count: 2 });

    const history = await cli(['history', NOTE, 'n-1', ...local.flags()], { fetch: globalThis.fetch, env });

    expect(history.stderr).toBe('');

    expect(history.output).toEqual({
      data: [
        {
          objectPrimaryKey: { noteId: { type: 'stringValue', value: 'n-1' } },
          operationId: expect.any(String),
          actionTypeRid: expect.any(String),
          userId: 'user_01HFORMER',
          timestamp: expect.any(String),
          edit: { type: 'createEdit', properties: { text: 'One' } },
        },
      ],
      totalCount: 1,
    });

    const byPerson = await cli(['history', NOTE, 'n-2', ...local.flags()], { fetch: globalThis.fetch, env });

    expect(byPerson.stderr).toBe('');

    expect((byPerson.output as { data: unknown[] }).data).toEqual([
      expect.objectContaining({ userId: STUB_PERSON.id, user: { name: 'Ada Lovelace', email: STUB_PERSON.email } }),
    ]);
  });
});
