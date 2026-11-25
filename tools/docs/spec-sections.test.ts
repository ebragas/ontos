import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anchors, badSections, slug, testNames } from './spec-sections.ts';

const specs: Record<string, string> = {
  'service/testing':
    '---\nstatus: specified\n---\n\n# Testing\n\n## Contract\n\n### Test kinds\n\n```md\n## In a fence\n```\n',
  GLOSSARY: '# Glossary\n\n## Object Type\n',
};

const check = (...names: string[]) => badSections(names, (doc) => specs[doc]);
const script = fileURLToPath(new URL('./spec-sections.ts', import.meta.url));

const reportOf = (...files: readonly (readonly string[])[]) => ({
  testResults: files.map((tests) => ({
    assertionResults: tests.map((fullName) => ({ fullName })),
  })),
});

describe('service/testing#test-names: the section check', () => {
  const scratch: string[] = [];

  afterAll(() => {
    for (const folder of scratch) rmSync(folder, { recursive: true, force: true });
  });

  const runCli = (files: Record<string, unknown>, args: readonly string[]) => {
    const folder = mkdtempSync(join(tmpdir(), 'spec-sections-'));

    scratch.push(folder);

    mkdirSync(join(folder, 'docs/service'), { recursive: true });

    writeFileSync(join(folder, 'docs/service/testing.md'), specs['service/testing'] ?? '');

    writeFileSync(join(folder, 'GLOSSARY.md'), specs['GLOSSARY'] ?? '');

    for (const [name, content] of Object.entries(files)) {
      const target = join(folder, name);

      mkdirSync(dirname(target), { recursive: true });

      writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
    }

    return spawnSync(process.execPath, [script, ...args], { cwd: folder, encoding: 'utf8' });
  };

  let cliRuns: {
    singleOk: ReturnType<typeof runCli>;
    singleFail: ReturnType<typeof runCli>;
    multiOk: ReturnType<typeof runCli>;
    multiFail: ReturnType<typeof runCli>;
    listOk: ReturnType<typeof runCli>;
  };

  beforeAll(() => {
    cliRuns = {
      singleOk: runCli({ 'unit.json': reportOf(['service/testing#test-kinds: a', 'GLOSSARY#object-type: b']) }, [
        'unit.json',
      ]),
      singleFail: runCli({ 'unit.json': reportOf(['service/testing#missing-heading: a']) }, ['unit.json']),
      multiOk: runCli(
        {
          'shard-1.json': reportOf(['service/testing#test-kinds: a']),
          'shard-2.json': reportOf(['GLOSSARY#object-type: b', 'plain test']),
        },
        ['shard-1.json', 'shard-2.json'],
      ),
      multiFail: runCli(
        {
          'shard-1.json': reportOf(['service/testing#test-kinds: a']),
          'shard-2.json': reportOf(['service/testing#unknown-in-shard-2: b']),
        },
        ['shard-1.json', 'shard-2.json'],
      ),
      listOk: runCli({ 'list.json': [{ name: 'service/testing#contract: a' }] }, ['list.json']),
    };
  });

  it('makes the GitHub anchor of a heading', () => {
    expect(slug('Test kinds')).toBe('test-kinds');
    expect(slug('1. Make the Ontology RID')).toBe('1-make-the-ontology-rid');
    expect(slug('`objectSets` and `ontology`')).toBe('objectsets-and-ontology');
  });

  it('numbers a repeated heading as GitHub does, and skips the front matter and each code fence', () => {
    expect([...anchors('## Apply\n\n## Other\n\n### Apply\n')]).toEqual(['apply', 'other', 'apply-1']);

    expect([
      ...anchors('## Contract\n\n~~~\n## In tilde\n~~~\n\n````md\n```\n## In four\n```\n````\n\n## Outside\n'),
    ]).toEqual(['contract', 'outside']);

    expect(anchors(specs['service/testing'] ?? '').has('in-a-fence')).toBe(false);
  });

  it('passes a section that its spec has, and a test name with no section ID', () => {
    expect(
      check(
        'service/testing#test-kinds: a test',
        'a > GLOSSARY#object-type, service/testing#contract: b',
        'no section',
      ),
    ).toEqual([]);

    expect(check('service/testing#test_kinds: c')).toEqual([
      'service/testing#test_kinds in "service/testing#test_kinds: c": no spec has this section.',
    ]);
  });

  it('fails a section that its spec does not have, and a spec that does not exist', () => {
    expect(
      check('service/testing#writes: a test', 'service/storage#writes: b', 'service/testing#in-a-fence: c'),
    ).toEqual([
      'service/testing#writes in "service/testing#writes: a test": no spec has this section.',
      'service/storage#writes in "service/storage#writes: b": no spec has this section.',
      'service/testing#in-a-fence in "service/testing#in-a-fence: c": no spec has this section.',
    ]);
  });

  it('checks a rule ID with a hash by its section', () => {
    const hash = '1a2b3c4d';

    expect(check(`service/testing#test-kinds/${hash}: a`, `service/testing#contract/${hash}-2: b`)).toEqual([]);

    expect(check(`service/testing#writes/${hash}: c`)).toEqual([
      `service/testing#writes in "service/testing#writes/${hash}: c": no spec has this section.`,
    ]);
  });

  it('extracts test names from a vitest list array and from a vitest JSON report', () => {
    expect(testNames([{ name: 'a > b' }, { name: 'c' }])).toEqual(['a > b', 'c']);
    expect(testNames(reportOf(['a b', 'c'], [], ['d']))).toEqual(['a b', 'c', 'd']);
    expect(testNames({ name: 'x' })).toBeUndefined();
    expect(testNames(null)).toBeUndefined();
    expect(testNames([{ fullName: 'a' }])).toBeUndefined();
    expect(testNames({ testResults: [{}] })).toBeUndefined();
    expect(testNames({ testResults: [{ assertionResults: [{ name: 'a' }] }] })).toBeUndefined();
  });

  it('checks a single vitest JSON report and fails on an unknown section', () => {
    const { singleOk: ok, singleFail: fail } = cliRuns;

    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('Each spec section that the 2 tests name is a heading of its spec.\n');

    expect(fail.status).toBe(1);

    expect(fail.stderr).toBe(
      'service/testing#missing-heading in "service/testing#missing-heading: a": no spec has this section.\n',
    );
  });

  it('checks multiple vitest JSON reports together, as from sharded runs', () => {
    const { multiOk: ok, multiFail: fail } = cliRuns;

    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('Each spec section that the 3 tests name is a heading of its spec.\n');

    expect(fail.status).toBe(1);

    expect(fail.stderr).toBe(
      'service/testing#unknown-in-shard-2 in "service/testing#unknown-in-shard-2: b": no spec has this section.\n',
    );
  });

  it('keeps support for vitest list JSON files', () => {
    const { listOk: ok } = cliRuns;

    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('Each spec section that the 1 tests name is a heading of its spec.\n');
  });
});
