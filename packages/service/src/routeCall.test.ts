import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const service = fileURLToPath(new URL('../', import.meta.url));
const PROBE = `${service}src/routeCall.probe.ts`;

const probe = [
  "import type { RouteCall } from './handler/index.ts';",
  "export const fullMetadata: RouteCall = { key: 'GET /api/v2/ontologies/{ontology}/fullMetadata', params: {} };",
  "export const editsHistory: RouteCall = { key: 'POST /api/v2/ontologies/{ontology}/objectTypes/{objectType}/editsHistory', params: { objectType: 'Account' }, body: {} };",
  "export const noTokenRoute: RouteCall = { key: 'POST /api/mcp', params: {} };",
  "export const missingParameter: RouteCall = { key: 'POST /api/v2/ontologies/{ontology}/objectTypes/{objectType}/editsHistory', params: {} };",
  "export const publishRoute: RouteCall = { key: 'POST /api/ontology-service/v1/publish', params: {} };",
].join('\n');

function diagnose(): [number, string][] {
  const config = ts.getParsedCommandLineOfConfigFile(
    `${service}tsconfig.json`,
    { noEmit: true },
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );

  if (!config) throw new Error('packages/service/tsconfig.json did not parse.');

  const host = ts.createCompilerHost(config.options);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);

  host.fileExists = (file) => file === PROBE || fileExists(file);
  host.readFile = (file) => (file === PROBE ? probe : readFile(file));

  const program = ts.createProgram([PROBE], config.options, host);
  const file = program.getSourceFile(PROBE);

  if (!file) throw new Error('The probe did not load.');

  return [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)].map((diagnostic) => {
    const line =
      diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
        : 0;

    return [line, ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')];
  });
}

describe('service/code-layout#seams: the RouteCall type', () => {
  it('service/code-layout#seams: tsc accepts a token route key with its path parameters, and refuses a key of no token route, a missing path parameter, and the publish route', () => {
    const diagnostics = diagnose();

    expect(diagnostics.map(([line]) => line)).toEqual([4, 5, 6]);
    expect(diagnostics[0]?.[1]).toContain('Type \'"POST /api/mcp"\' is not assignable to type');
    expect(diagnostics[1]?.[1]).toContain("Property 'objectType' is missing in type '{}'");
    expect(diagnostics[2]?.[1]).toContain('Type \'"POST /api/ontology-service/v1/publish"\' is not assignable to type');
  });
});
