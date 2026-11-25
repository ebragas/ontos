import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, CLI_VERSION, ROOT, SERVICE_VERSION, tempFolder } from '../cli.test-utils.ts';
import { INIT_OSDK_PACKAGES } from './init.ts';

describe('ontos init', () => {
  it('pins the exact OSDK package versions from packages/service/osdk-sets.json', () => {
    const sets = JSON.parse(readFileSync(join(ROOT, 'packages/service/osdk-sets.json'), 'utf8')) as {
      packages: Record<string, string>;
    }[];

    expect(INIT_OSDK_PACKAGES).toEqual(sets[0]?.packages);
  });

  it('scaffolds a minimal Ontology project in a target directory and refuses to overwrite without --force', async () => {
    const parent = tempFolder();

    const first = await cli(['init', 'my-tasks'], { cwd: parent });

    const dir = join(parent, 'my-tasks');

    expect(first.code).toBe(0);
    expect(first.stderr).toBe('');

    expect(first.output).toEqual({
      directory: dir,
      files: [
        'ontos.yml',
        'package.json',
        'ontology/src/ontology.mts',
        'ontology/src/grants.json',
        '.ontology/schema-migrations.json',
        '.gitignore',
      ],
    });

    expect(readFileSync(join(dir, 'ontos.yml'), 'utf8')).toContain('apiNamespace: com.example.tasks');

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(pkg.name).toBe('my-tasks');
    expect(pkg.dependencies).toEqual(INIT_OSDK_PACKAGES);

    expect(pkg.devDependencies).toEqual({
      '@ericbragas/ontos-cli': CLI_VERSION,
      '@ericbragas/ontos-service': SERVICE_VERSION,
    });

    expect(JSON.parse(readFileSync(join(dir, '.ontology/schema-migrations.json'), 'utf8'))).toEqual({ migrations: [] });
    expect(readFileSync(join(dir, 'ontology/src/ontology.mts'), 'utf8')).toContain("apiName: 'Task'");
    expect(readFileSync(join(dir, 'ontology/src/grants.json'), 'utf8')).toContain('com.example.tasks.Task');
    expect(existsSync(join(dir, '.gitignore'))).toBe(true);

    writeFileSync(join(dir, 'ontos.yml'), 'custom: true\n');

    const refused = await cli(['init', 'my-tasks'], { cwd: parent });

    expect(refused.code).toBe(1);
    expect(refused.error).toMatchObject({ message: expect.stringContaining('Pass --force to overwrite.') });
    expect(readFileSync(join(dir, 'ontos.yml'), 'utf8')).toBe('custom: true\n');

    const forced = await cli(['init', 'my-tasks', '--force'], { cwd: parent });

    expect(forced.code).toBe(0);
    expect(readFileSync(join(dir, 'ontos.yml'), 'utf8')).toContain('apiNamespace: com.example.tasks');
  });

  it('defaults to the current directory, prints TTY-friendly output when isTty is true, and runs generate-osdk with no deployment file', async () => {
    const dir = tempFolder();

    const initRun = await cli(['init'], { cwd: dir, isTty: true });

    expect(initRun.code).toBe(0);
    expect(initRun.stdout).toContain(`Initialized Ontos project in ${dir}`);
    expect(initRun.stdout).toContain('ontos.yml');

    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');

    const genRun = await cli(['generate-osdk'], { cwd: dir });

    expect(genRun.stderr).toBe('');
    expect(genRun.code).toBe(0);
    expect(genRun.output).toEqual({ osdkOutput: 'ontology/osdk-output/ontology', passes: 1 });
    expect(existsSync(join(dir, 'ontology/osdk-output/ontology/dist/index.js'))).toBe(true);
  });
});
