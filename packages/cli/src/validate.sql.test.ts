import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GATE_DEPLOYMENT_FILE, NOTES_GRANTS, notesApp, OSDK_SET } from './apps.test-utils.ts';
import { cli, CLI_VERSION, stubConfig, stubFetch, type Handler } from './cli.test-utils.ts';

const STAGING_DEPLOYMENT_FILE = (() => {
  const { production, ...gate } = JSON.parse(GATE_DEPLOYMENT_FILE) as {
    production: { workosClientId: string; authkitDomain: string };
  };

  const staging = {
    ...production,
    baseUrl: 'https://notes-staging.ontos.example',
    trustedGithubRepository: 'example/notes-ontology',
    trustedGithubEnvironment: 'ontology-staging',
    mcp: false,
  };

  return JSON.stringify({ ...gate, staging }, null, 2);
})();

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      encoding: 'utf8',
    },
  ).trim();
}

function commitFiles(root: string, files: Readonly<Record<string, string>>, message: string): string {
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);

    mkdirSync(dirname(full), { recursive: true });

    writeFileSync(full, text);
  }

  git(root, 'add', '-A');

  git(root, 'commit', '-qm', message);

  return git(root, 'rev-parse', 'HEAD');
}

const NOTES_FOUNDRY_YML = `components:
  - type: ONTOLOGY
    path: ./ontology
osdkOutput: ontology/osdk-output
apiNamespace: com.example.notes
`;

function gitStagingNotesApp(
  baseCliVersion: string,
  baseFiles: Readonly<Record<string, string>> = {},
): { root: string; base: string } {
  const root = notesApp({
    '.gitignore': 'node_modules\n',
    'foundry.yml': NOTES_FOUNDRY_YML,
    '.ontology/deployment.json': STAGING_DEPLOYMENT_FILE,
    'package.json': `${JSON.stringify({ private: true, dependencies: { '@ericbragas/ontos-cli': baseCliVersion, ...OSDK_SET } }, null, 2)}\n`,
    ...baseFiles,
  });

  git(root, 'init', '-q', '-b', 'staging');

  const base = commitFiles(root, {}, 'base');

  return { root, base };
}

describe('ontos validate --local and --base against a real local service', () => {
  let releasePinApp: { root: string; base: string };

  beforeAll(() => {
    releasePinApp = gitStagingNotesApp('2.0.1', {
      'ontology/src/grants.json': JSON.stringify({ roles: ['admin', 'member'], objectTypes: {}, actionTypes: {} }),
    });

    commitFiles(
      releasePinApp.root,
      {
        'package.json': `${JSON.stringify({ private: true, dependencies: { '@ericbragas/ontos-cli': CLI_VERSION, ...OSDK_SET } }, null, 2)}\n`,
        'ontology/src/grants.json': NOTES_GRANTS,
        '.ontology/deployment.json': STAGING_DEPLOYMENT_FILE,
      },
      'move to v3',
    );
  });

  it('service/deployment#managed-files: a release-pin PR with a new grants format and no Ontology schema change validates locally, never calls staging, and cleans up', async () => {
    const { root, base } = releasePinApp;

    const generated = await cli(['generate-osdk'], { cwd: root });

    expect(generated.code).toBe(0);

    const rejectStaging: Handler = () =>
      Response.json(
        {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'Default:InvalidArgument',
          parameters: { message: 'old staging rejects v3' },
        },
        { status: 400 },
      );

    const fetch = stubFetch(stubConfig, rejectStaging);
    const networkBefore = globalThis.fetch;

    const run = await cli(['validate', '--app', 'notes', '--env', 'staging', '--base', base], {
      cwd: root,
      fetch,
      env: {
        GITHUB_ACTIONS: 'true',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh-token',
      },
    });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(fetch.calls).toEqual([]);
    expect(globalThis.fetch).toBe(networkBefore);

    const output = run.output as {
      local: boolean;
      changes: unknown[];
      metadata: { objectTypes: Record<string, unknown> };
      version?: number;
    };

    expect(output.local).toBe(true);
    expect(output.version).toBeUndefined();
    expect(Object.keys(output.metadata.objectTypes)).toEqual(['com.example.notes.Note']);
  });

  it('service/cli#commands: ontos validate --local validates against a local service and fails cleanly on a broken grants file', async () => {
    const cwd = notesApp({ '.ontology/deployment.json': STAGING_DEPLOYMENT_FILE });
    const fetch = stubFetch();
    const networkBefore = globalThis.fetch;

    const ok = await cli(['validate', '--local', '--app', 'notes'], { cwd, fetch });

    expect(ok.stderr).toBe('');
    expect(ok.code).toBe(0);
    expect(fetch.calls).toEqual([]);
    expect(globalThis.fetch).toBe(networkBefore);
    expect((ok.output as { local: boolean }).local).toBe(true);

    const badGrants = JSON.stringify({
      permissions: { 'notes:use': { description: 'Use the notes' } },
      objectTypes: {},
      actionTypes: { 'com.example.notes.create-note': 'notes:use' },
      defaultRoles: { admin: ['ontology:install', 'notes:use'] },
    });

    const bad = await cli(['validate', '--local', '--app', 'notes'], {
      cwd: notesApp({ '.ontology/deployment.json': STAGING_DEPLOYMENT_FILE, 'ontology/src/grants.json': badGrants }),
      fetch,
    });

    expect(bad.code).toBe(1);
    expect(JSON.stringify(bad.error)).toContain('com.example.notes.Note');
    expect(globalThis.fetch).toBe(networkBefore);
  });
});
