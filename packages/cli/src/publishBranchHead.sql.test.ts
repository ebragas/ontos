import { afterEach, describe, expect, it } from 'vitest';
import { notesApp, NOTES_ONTOLOGY } from './apps.test-utils.ts';
import { hashOf, NAME, withStaging } from './sdk/sdkPackage.test-utils.ts';
import { expectAllOnNewest, localGate, toLocal } from './sql.test-utils.ts';
import { cli, stubFetch, stubRegistry, type Handler, type PackageVersion } from './cli.test-utils.ts';

const local = localGate('production');

afterEach(() => expectAllOnNewest(local.service));

const PUSH_1 = '1'.repeat(40);
const PUSH_2 = '2'.repeat(40);
const PUSH_3 = '3'.repeat(40);
const API = 'https://api.github.com';
const REPOSITORY = 'example/app-ontology';
const ROUTES = /\/api\/ontology-service\/v1\/publish$/;

const PUSH_2_ONTOLOGY = NOTES_ONTOLOGY.replace('displayName: "Note",', 'displayName: "Memo",');

const appOf = (commit: string): string =>
  notesApp({
    '.ontology/deployment.json': JSON.stringify(withStaging()),
    ...(commit === PUSH_2 ? { 'ontology/src/ontology.mts': PUSH_2_ONTOLOGY } : {}),
  });

const github =
  (head: () => string): Handler =>
  (call) =>
    call.url === `${API}/repos/${REPOSITORY}/git/ref/heads/main`
      ? Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: head() } })
      : undefined;

const loseResponse: Handler = async (call) => {
  if (!call.url.endsWith('/api/ontology-service/v1/publish')) return undefined;

  await toLocal(call);

  return new Response('upstream request timeout', { status: 504 });
};

function recordingRegistry(packages: Readonly<Record<string, readonly PackageVersion[]>>) {
  const stub = stubRegistry(packages);
  const find = stub.find.bind(stub);
  const finds: string[] = [];

  return Object.assign(stub, {
    finds,
    find: (...args: Parameters<typeof find>) => {
      finds.push(args[0]);

      return find(...args);
    },
  });
}

async function metadataOf(commit: string): Promise<unknown> {
  const validated = await cli(['validate', ...local.flags()], {
    cwd: appOf(commit),
    fetch: stubFetch(toLocal),
    env: local.service.oidcEnv,
  });

  return (validated.output as { metadata: unknown }).metadata;
}

describe('a re-run of a publish job', () => {
  it('service/publish#applying, service/cli#publish-job: a re-run of a commit that is not the head publishes nothing and moves no tag, and a re-run of the head after a lost response makes no new version', async () => {
    let head = PUSH_1;

    const [hash1, hash2] = [hashOf(await metadataOf(PUSH_1)), hashOf(await metadataOf(PUSH_2))];

    const registry = recordingRegistry({
      [NAME]: [
        { version: '0.0.5', ontologyHash: hash1 },
        { version: '0.0.6', ontologyHash: hash2 },
      ],
    });

    const publishAt = async (commit: string, lost = false) => {
      const fetch = stubFetch(
        github(() => head),
        ...(lost ? [loseResponse] : []),
        toLocal,
      );

      const env = {
        ...local.service.oidcEnv,
        GITHUB_ACTIONS: 'true',
        GITHUB_SHA: commit,
        GITHUB_REF_NAME: 'main',
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_API_URL: API,
        NODE_AUTH_TOKEN: 'ghs_test',
      };

      const run = await cli(['publish', ...local.flags()], { cwd: appOf(commit), fetch, env, registry });

      const output = run.output as { version?: number; changes?: unknown[] } | undefined;

      return {
        code: run.code,
        version: output?.version,
        changes: output?.changes,
        serviceCalls: fetch.calls.filter(({ url }) => ROUTES.test(url)).length,
        message: (run.error as { message?: string } | undefined)?.message,
      };
    };

    const tags = () => registry.tags.map(({ version, tag }) => `${tag}@${version}`);

    expect((await publishAt(PUSH_1, true)).code).toBe(1);

    head = PUSH_2;

    expect(await publishAt(PUSH_2)).toMatchObject({ code: 0, version: 2 });

    expect(tags()).toEqual(['production@0.0.6', 'latest@0.0.6']);

    registry.finds.length = 0;

    const rerun = await publishAt(PUSH_1);

    expect({ ...rerun, finds: registry.finds, tags: tags() }).toEqual({
      code: 1,
      version: undefined,
      changes: undefined,
      serviceCalls: 0,
      message: `The commit ${PUSH_1} is not the head of the branch main, which is ${PUSH_2}. A re-run of an older commit publishes nothing.`,
      finds: [],
      tags: ['production@0.0.6', 'latest@0.0.6'],
    });

    expect(await publishAt(PUSH_2)).toMatchObject({ code: 0, version: 2, changes: [] });

    head = PUSH_3;

    expect(await publishAt(PUSH_3, true)).toMatchObject({ code: 1, version: undefined });

    expect(await publishAt(PUSH_3)).toMatchObject({ code: 0, version: 3, changes: [] });

    expect(tags().slice(-2)).toEqual(['production@0.0.5', 'latest@0.0.5']);
  });
});
