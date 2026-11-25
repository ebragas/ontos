import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { notesApp, OSDK_SET } from '../apps.test-utils.ts';
import { cli, STUB, stubConfig, stubFetch, type Handler } from '../cli.test-utils.ts';
import { classifyValidationMode, ontologySchemaFiles, type AppLayout } from './mode.ts';

const LAYOUT: AppLayout = {
  ontology: 'ontology',
  functions: 'functions/typescript-functions',
  osdkOutput: 'ontology/osdk-output',
};

const PUBLISH_URL = `${STUB}/api/ontology-service/v1/publish`;

const PUBLISH_OK: Handler = ({ method, url }) =>
  method === 'POST' && url === PUBLISH_URL
    ? Response.json({ changes: [], metadata: { ontology: { rid: 'ri.ontology.main.ontology.stub' } } })
    : undefined;

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

function gitNotesApp(cliVersion: string, extra: Readonly<Record<string, string>> = {}): { root: string; base: string } {
  const root = notesApp({
    '.gitignore': 'node_modules\n',
    'package.json': `${JSON.stringify({ private: true, dependencies: { '@ericbragas/ontos-cli': cliVersion, ...OSDK_SET } }, null, 2)}\n`,
    ...extra,
  });

  git(root, 'init', '-q', '-b', 'staging');

  const base = commitFiles(root, {}, 'base');

  return { root, base };
}

describe('classifyValidationMode', () => {
  it('service/deployment#managed-files: unchanged CLI pin stays remote regardless of changed files', () => {
    expect(
      classifyValidationMode({
        fromRelease: '3.0.0',
        toRelease: '3.0.0',
        changedPaths: ['ontology/src/ontology.mts', 'ontology/src/grants.json', '.ontology/schema-migrations.json'],
        layout: LAYOUT,
      }),
    ).toEqual({ kind: 'remote' });
  });

  it('service/deployment#managed-files: missing CLI pin on base or head stays remote', () => {
    expect(
      classifyValidationMode({
        fromRelease: undefined,
        toRelease: '3.0.0',
        changedPaths: ['package.json'],
        layout: LAYOUT,
      }),
    ).toEqual({ kind: 'remote' });

    expect(
      classifyValidationMode({
        fromRelease: '2.0.1',
        toRelease: undefined,
        changedPaths: ['package.json'],
        layout: LAYOUT,
      }),
    ).toEqual({ kind: 'remote' });
  });

  it('service/deployment#managed-files: changed CLI pin with no Ontology schema change selects local, allowing grants, deployment, workflows, osdkOutput, domain, and tests', () => {
    expect(
      classifyValidationMode({
        fromRelease: '2.0.1',
        toRelease: '3.0.0-rc.1',
        changedPaths: [
          'package.json',
          'package-lock.json',
          '.ontology/deployment.json',
          'ontology/src/grants.json',
          'ontology/osdk-output/ontology/package.json',
          '.github/workflows/ontology.yml',
          '.github/workflows/ontology-reset.yml',
          '.nvmrc',
          'domain/index.ts',
          'tests/account.test.ts',
        ],
        layout: LAYOUT,
      }),
    ).toEqual({ kind: 'local', fromRelease: '2.0.1', toRelease: '3.0.0-rc.1' });
  });

  it('service/deployment#managed-files: changed CLI pin with any Ontology schema file selects mixed and lists those files sorted', () => {
    expect(
      classifyValidationMode({
        fromRelease: '3.0.0-rc.1',
        toRelease: '3.0.0-rc.3',
        changedPaths: [
          'package.json',
          'ontology/src/ontology.mts',
          'ontology/src/helpers/note.ts',
          '.ontology/schema-migrations.json',
          'functions/typescript-functions/src/functions/closeAccount.ts',
          'foundry.yml',
          'ontology/src/grants.json',
          '.ontology/deployment.json',
        ],
        layout: LAYOUT,
      }),
    ).toEqual({
      kind: 'mixed',
      fromRelease: '3.0.0-rc.1',
      toRelease: '3.0.0-rc.3',
      ontologyFiles: [
        '.ontology/schema-migrations.json',
        'foundry.yml',
        'functions/typescript-functions/src/functions/closeAccount.ts',
        'ontology/src/helpers/note.ts',
        'ontology/src/ontology.mts',
      ],
    });
  });

  it('service/deployment#managed-files: ontologySchemaFiles respects custom component paths and does not match sibling prefixes', () => {
    const custom: AppLayout = { ontology: 'model', functions: 'code/fns', osdkOutput: 'model/sdk' };

    expect(
      ontologySchemaFiles(
        [
          'model/src/ontology.mts',
          'model/src/grants.json',
          'model/sdk/package.json',
          'model-extra/file.ts',
          'code/fns/src/a.ts',
          'code/fns-other/b.ts',
        ],
        custom,
      ),
    ).toEqual(['code/fns/src/a.ts', 'model/src/ontology.mts']);
  });
});

describe('ontos validate flags and --base mode', () => {
  let gitFixtures: {
    ordinaryPr: { root: string; base: string };
    mixedPr: { root: string; base: string };
    movedHelperPr: { root: string; base: string };
    behindStagingPr: { root: string };
    releasePinMovePr: { root: string; base: string };
    missingBaseRefApp: { root: string };
  };

  beforeAll(() => {
    const ordinaryPr = gitNotesApp('3.0.0');

    commitFiles(ordinaryPr.root, { 'README.md': 'updated\n' }, 'ordinary pr');

    const mixedPr = gitNotesApp('2.0.1');

    commitFiles(
      mixedPr.root,
      {
        'package.json': `${JSON.stringify({ private: true, dependencies: { '@ericbragas/ontos-cli': '3.0.0', ...OSDK_SET } }, null, 2)}\n`,
        'ontology/src/ontology.mts': '// edited\n',
        '.ontology/schema-migrations.json': '{"migrations":[]}\n',
      },
      'mixed pr',
    );

    const movedHelperPr = gitNotesApp('2.0.1', { 'ontology/src/helper.ts': 'export const helper = 1;\n' });

    rmSync(join(movedHelperPr.root, 'ontology/src/helper.ts'));

    commitFiles(
      movedHelperPr.root,
      {
        'package.json': `${JSON.stringify({ private: true, dependencies: { '@ericbragas/ontos-cli': '3.0.0', ...OSDK_SET } }, null, 2)}\n`,
        'lib/helper.ts': 'export const helper = 1;\n',
      },
      'move helper out of ontology',
    );

    const behindStagingPr = gitNotesApp('2.0.1');

    git(behindStagingPr.root, 'checkout', '-qb', 'feature/ontology-edit');

    commitFiles(
      behindStagingPr.root,
      { 'ontology/src/helper.ts': 'export const helper = 1;\n' },
      'edit ontology on 2.0.1',
    );

    git(behindStagingPr.root, 'checkout', '-q', 'staging');

    commitFiles(
      behindStagingPr.root,
      {
        'package.json': `${JSON.stringify({ private: true, dependencies: { '@ericbragas/ontos-cli': '3.0.0', ...OSDK_SET } }, null, 2)}\n`,
      },
      'bump staging to 3.0.0',
    );

    git(behindStagingPr.root, 'checkout', '-q', 'feature/ontology-edit');

    const releasePinMovePr = gitNotesApp('2.0.1');

    commitFiles(
      releasePinMovePr.root,
      {
        'package.json': `${JSON.stringify({ private: true, dependencies: { '@ericbragas/ontos-cli': '3.0.0', ...OSDK_SET } }, null, 2)}\n`,
      },
      'release pin move',
    );

    const missingBaseRefApp = gitNotesApp('3.0.0');

    gitFixtures = {
      ordinaryPr,
      mixedPr,
      movedHelperPr,
      behindStagingPr,
      releasePinMovePr,
      missingBaseRefApp,
    };
  });

  it('service/cli#commands: validate refuses invalid flag combinations with --local and --base', async () => {
    const cwd = notesApp();
    const env = { ONTOLOGY_APP: 'notes', ONTOLOGY_TOKEN: 't' };

    expect((await cli(['validate', '--local', '--base', 'HEAD'], { cwd, env })).error).toEqual({
      message: 'ontos validate does not take both --local and --base.',
    });

    expect((await cli(['validate', '--local', '--url', STUB], { cwd, env })).error).toEqual({
      message: 'ontos validate --local starts its own local service, so it does not take --url.',
    });

    expect((await cli(['validate', '--local', '--test-user'], { cwd, env: { ONTOLOGY_APP: 'notes' } })).error).toEqual({
      message: 'ontos validate --local starts its own local service, so it does not take --test-user.',
    });

    expect((await cli(['validate', '--local', '--env', 'production'], { cwd, env })).error).toEqual({
      message:
        'ontos validate --local runs the staging settings of .ontology/deployment.json, so it does not take --env production.',
    });

    expect((await cli(['validate', '--base', ''], { cwd, env })).error).toEqual({
      message: '--base needs a Git commit or ref: ontos validate --base <ref>',
    });

    expect((await cli(['publish', '--local'], { cwd, env })).error).toEqual({
      message: 'ontos publish does not take --local.',
    });

    expect((await cli(['publish', '--base', 'HEAD'], { cwd, env })).error).toEqual({
      message: 'ontos publish does not take --base.',
    });
  });

  it('service/deployment#managed-files: validate --base validates remotely against staging when the CLI pin did not change', async () => {
    const { root, base } = gitFixtures.ordinaryPr;

    const fetch = stubFetch(stubConfig, PUBLISH_OK);

    const run = await cli(['validate', '--app', 'notes', '--url', STUB, '--base', base], {
      cwd: root,
      fetch,
      env: { ONTOLOGY_TOKEN: 't' },
    });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(fetch.calls.some(({ url }) => url === PUBLISH_URL)).toBe(true);
  });

  it('service/deployment#managed-files: validate --base fails before calling staging when both the CLI pin and an Ontology schema file changed', async () => {
    const { root, base } = gitFixtures.mixedPr;

    const fetch = stubFetch(stubConfig, PUBLISH_OK);

    const run = await cli(['validate', '--app', 'notes', '--url', STUB, '--base', base], {
      cwd: root,
      fetch,
      env: { ONTOLOGY_TOKEN: 't' },
    });

    expect(run.code).toBe(1);

    expect(run.error).toEqual({
      message:
        'This pull request changes both the pinned CLI release (2.0.1 to 3.0.0) and the Ontology (ontology/src/ontology.mts). Split this into 2 pull requests: move the release first, then change the Ontology.',
      fromRelease: '2.0.1',
      toRelease: '3.0.0',
      files: ['ontology/src/ontology.mts'],
    });

    expect(fetch.calls).toEqual([]);
  });

  it('service/deployment#managed-files: validate --base catches a file moved out of ontology/ via --no-renames', async () => {
    const { root, base } = gitFixtures.movedHelperPr;

    const fetch = stubFetch(stubConfig, PUBLISH_OK);

    const run = await cli(['validate', '--app', 'notes', '--url', STUB, '--base', base], {
      cwd: root,
      fetch,
      env: { ONTOLOGY_TOKEN: 't' },
    });

    expect(run.code).toBe(1);
    expect(run.error).toMatchObject({ files: ['ontology/src/helper.ts'] });
    expect(fetch.calls).toEqual([]);
  });

  it('service/deployment#managed-files: validate --base reads fromRelease from merge-base so a branch behind a newer staging CLI bump stays remote', async () => {
    const { root } = gitFixtures.behindStagingPr;

    const fetch = stubFetch(stubConfig, PUBLISH_OK);

    const run = await cli(['validate', '--app', 'notes', '--url', STUB, '--base', 'staging'], {
      cwd: root,
      fetch,
      env: { ONTOLOGY_TOKEN: 't' },
    });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(fetch.calls.some(({ url }) => url === PUBLISH_URL)).toBe(true);
  });

  it('service/cli#commands: validate --base refuses --env production when the pull request selects local validation', async () => {
    const { root, base } = gitFixtures.releasePinMovePr;

    const fetch = stubFetch(stubConfig, PUBLISH_OK);

    const run = await cli(['validate', '--app', 'notes', '--env', 'production', '--base', base], {
      cwd: root,
      fetch,
      env: { ONTOLOGY_TOKEN: 't' },
    });

    expect(run.code).toBe(1);

    expect(run.error).toEqual({
      message:
        'ontos validate --local runs the staging settings of .ontology/deployment.json, so it does not take --env production.',
    });

    expect(fetch.calls).toEqual([]);
  });

  it('service/deployment#managed-files: validate --base fails clearly when the base ref does not exist in Git', async () => {
    const { root } = gitFixtures.missingBaseRefApp;
    const fetch = stubFetch(stubConfig, PUBLISH_OK);

    const run = await cli(['validate', '--app', 'notes', '--url', STUB, '--base', 'deadbeefdeadbeef'], {
      cwd: root,
      fetch,
      env: { ONTOLOGY_TOKEN: 't' },
    });

    expect(run.code).toBe(1);
    expect((run.error as { message: string }).message).toContain('deadbeefdeadbeef');
    expect(fetch.calls).toEqual([]);
  });
});
