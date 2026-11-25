import { describe, expect, it } from 'vitest';
import { NOTES_ONTOLOGY, notesApp, TWIN_FUNCTIONS, twinFunction, twinFunctionsApp } from './apps.test-utils.ts';
import { cli, STUB, stubConfig, stubFetch, type Handler } from './cli.test-utils.ts';

const flags = ['--app', 'notes', '--url', STUB];
const env = { ONTOLOGY_TOKEN: 't' };
const PUBLISH = `${STUB}/api/ontology-service/v1/publish`;
const ANSWER = { changes: [], metadata: { ontology: { rid: 'ri.ontology.main.ontology.stub' } }, version: 1 };

const route: Handler = ({ method, url }) => (method === 'POST' && url === PUBLISH ? Response.json(ANSWER) : undefined);

const warnings = (stderr: string): string[] =>
  stderr
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as { warning: string }).warning);

const UNDESCRIBED_NOTES = `import { defineCreateObjectAction, defineObject } from "@osdk/maker";

const note = defineObject({
    apiName: "Note",
    displayName: "Note",
    pluralDisplayName: "Notes",
    titlePropertyApiName: "text",
    primaryKeyPropertyApiName: "noteId",
    properties: {
        noteId: { type: "string", displayName: "Note ID" },
        text: { type: "string" },
    },
    editsEnabled: true,
    includeEmptyBackingDatasource: true,
});

defineCreateObjectAction({ objectType: note, apiName: "create-note" });
`;

describe('warnings for elements with no description', () => {
  it.each(['validate', 'publish'])(
    'service/cli#output/7cdf2868: %s warns for each Object Type, Property, Action Type, and Action parameter with no description, in sorted order, and exits 0',
    async (command) => {
      const run = await cli([command, ...flags], {
        cwd: notesApp({ 'ontology/src/ontology.mts': UNDESCRIBED_NOTES }),
        fetch: stubFetch(stubConfig, route),
        env,
      });

      expect(run.code).toBe(0);

      expect(warnings(run.stderr)).toEqual([
        'Object Type com.example.notes.Note has no description.',
        'Property com.example.notes.Note.noteId has no description.',
        'Property com.example.notes.Note.text has no description.',
        'Action Type com.example.notes.create-note has no description.',
        'Parameter noteId of Action Type com.example.notes.create-note has no description.',
        'Parameter text of Action Type com.example.notes.create-note has no description.',
      ]);
    },
  );

  it.each(['validate', 'publish'])(
    'service/cli#output/7cdf2868: %s of an app that describes each element prints no warning',
    async (command) => {
      const run = await cli([command, ...flags], { cwd: notesApp(), fetch: stubFetch(stubConfig, route), env });

      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
    },
  );

  it('service/cli#output/7cdf2868: a description of only spaces counts as none', async () => {
    const blank = NOTES_ONTOLOGY.replace('"The ID of the note."', '"  "');

    const run = await cli(['validate', ...flags], {
      cwd: notesApp({ 'ontology/src/ontology.mts': blank }),
      fetch: stubFetch(stubConfig, route),
      env,
    });

    expect(warnings(run.stderr)).toEqual(['Property com.example.notes.Note.noteId has no description.']);
  });

  it('service/cli#output/7cdf2868: the warnings change nothing on stdout', async () => {
    const without = await cli(['validate', ...flags], { cwd: notesApp(), fetch: stubFetch(stubConfig, route), env });

    const withWarnings = await cli(['validate', ...flags], {
      cwd: notesApp({ 'ontology/src/ontology.mts': UNDESCRIBED_NOTES }),
      fetch: stubFetch(stubConfig, route),
      env,
    });

    expect(without.stderr).toBe('');
    expect(withWarnings.stderr).not.toBe('');
    expect(withWarnings.stdout).toBe(without.stdout);
    expect(withWarnings.stdout).toBe(`${JSON.stringify(ANSWER)}\n`);
  });

  it('service/cli#output/7cdf2868: a Link Type with no description and a function-backed parameter with no @param tag warn, and a Query Function warns for nothing', async () => {
    const doc =
      '/**\n * Closes the account.\n * @param reason - Why the account closes.\n */\nexport default async function closeAccount(';

    const query = [
      'import type { Client } from "@osdk/client";',
      '/** Counts. */',
      'export default async function countThings(client: Client, label: string): Promise<number> {',
      '  return label.length;',
      '}',
      '',
    ].join('\n');

    const files = {
      'functions/typescript-functions/src/functions/closeAccount.ts': twinFunction('closeAccount').replace(
        'export default async function closeAccount(',
        doc,
      ),
      'functions/typescript-functions/src/functions/countThings.ts': query,
    };

    const run = await cli(['validate', ...flags], {
      cwd: twinFunctionsApp(files),
      fetch: stubFetch(stubConfig, route),
      env,
    });

    expect(run.code).toBe(0);

    const lines = warnings(run.stderr);

    expect(lines).toContain('Link Type accountToEngagements has no description.');

    expect(lines).toContain(
      'Parameter account of Action Type com.example.twin.close-account-action has no description.',
    );

    expect(lines).not.toContain(
      'Parameter reason of Action Type com.example.twin.close-account-action has no description.',
    );

    expect(lines.filter((line) => line.includes('countThings') || line.includes('label'))).toEqual([]);
    expect(TWIN_FUNCTIONS).toContain('closeAccount');
  });
});
