import { existsSync, readFileSync } from 'node:fs';

const SECTION_ID = /(?<![\w/])(GLOSSARY|(?:service|ontology|adr)(?:\/[\w.-]+)+)#([a-z0-9_-]+)/g;

export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

export function anchors(markdown: string): Set<string> {
  const lines = markdown.split('\n');
  const found = new Set<string>();
  const seen = new Map<string, number>();
  let fence: { char: string; length: number } | null = null;
  const start = lines[0] === '---' ? lines.indexOf('---', 1) + 1 : 0;

  for (const raw of lines.slice(start)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);

    if (marker) {
      const [, run = '', rest = ''] = marker;

      if (!fence) fence = { char: run.charAt(0), length: run.length };
      else if (run.charAt(0) === fence.char && run.length >= fence.length && rest.trim() === '') fence = null;

      continue;
    }

    const heading = fence ? null : /^#{1,6}\s+(.*)$/.exec(raw);

    if (!heading) continue;

    const base = slug(heading[1] ?? '');
    const count = seen.get(base) ?? 0;

    seen.set(base, count + 1);

    found.add(count === 0 ? base : `${base}-${count}`);
  }

  return found;
}

export function badSections(names: readonly string[], readSpec: (doc: string) => string | undefined): string[] {
  const specs = new Map<string, Set<string> | undefined>();
  const bad = new Map<string, string>();

  for (const name of names) {
    for (const [id, doc = '', anchor = ''] of name.matchAll(SECTION_ID)) {
      if (bad.has(id)) continue;

      if (!specs.has(doc)) {
        const text = readSpec(doc);

        specs.set(doc, text === undefined ? undefined : anchors(text));
      }

      if (!specs.get(doc)?.has(anchor)) bad.set(id, `${id} in "${name}": no spec has this section.`);
    }
  }

  return [...bad.values()];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export function testNames(data: unknown): string[] | undefined {
  if (Array.isArray(data)) {
    const names: string[] = [];

    for (const entry of data) {
      if (!isRecord(entry) || typeof entry['name'] !== 'string') return undefined;

      names.push(entry['name']);
    }

    return names;
  }

  if (!isRecord(data) || !Array.isArray(data['testResults'])) return undefined;

  const names: string[] = [];

  for (const file of data['testResults']) {
    if (!isRecord(file) || !Array.isArray(file['assertionResults'])) return undefined;

    for (const test of file['assertionResults']) {
      if (!isRecord(test) || typeof test['fullName'] !== 'string') return undefined;

      names.push(test['fullName']);
    }
  }

  return names;
}

function readSpec(doc: string): string | undefined {
  const path = doc === 'GLOSSARY' ? 'GLOSSARY.md' : `docs/${doc}.md`;

  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function main(args: readonly string[]): number {
  if (args.length === 0) {
    console.error('Usage: node tools/docs/spec-sections.ts <vitest-json>...');

    return 2;
  }

  const names: string[] = [];

  for (const path of args) {
    const found = testNames(JSON.parse(readFileSync(path, 'utf8')));

    if (found === undefined) {
      console.error(`${path}: expected a vitest list array or a vitest JSON report.`);

      return 1;
    }

    for (const name of found) names.push(name);
  }

  const bad = badSections(names, readSpec);

  for (const line of bad) console.error(line);

  if (bad.length > 0) return 1;

  console.log(`Each spec section that the ${names.length} tests name is a heading of its spec.`);

  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
