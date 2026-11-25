import type { ActionTypeV2, OntologyFullMetadata } from '@osdk/foundry.ontologies';
import { CliError } from '../cliError.ts';
import { type DeploymentFile, ENVIRONMENTS } from '../deploymentFile.ts';
import type { Fallible } from '../fallible.ts';

export const SERVICE_MODULE_NAME = 'ontology-service';

export type ModuleEnvironments = Pick<DeploymentFile, 'staging' | 'production'>;

interface ModuleExport {
  readonly imports: readonly string[];
  readonly text: string;
}

const IDENTIFIER_FORM = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function* actionConstant(apiName: string): Fallible<string, CliError> {
  const camelized = apiName.replace(/-./g, (segment) => segment.charAt(1).toUpperCase());
  const identifier = camelized.slice(camelized.lastIndexOf('.') + 1);

  if (!IDENTIFIER_FORM.test(identifier))
    return yield new CliError(
      `Action Type ${apiName} produces an invalid TypeScript identifier ${JSON.stringify(identifier)}.`,
    );

  return identifier;
}

function* displayName(actionType: ActionTypeV2): Fallible<string, CliError> {
  if (actionType.displayName === undefined)
    return yield new CliError(
      `Action Type ${actionType.apiName} has no display name. The ${SERVICE_MODULE_NAME} module of the Ontology SDK holds the display name of each Action Type.`,
    );

  return actionType.displayName;
}

function* actionTypesByRid(metadata: OntologyFullMetadata): Fallible<ModuleExport, CliError> {
  const actionTypes = Object.values(metadata.actionTypes).sort((a, b) =>
    a.apiName < b.apiName ? -1 : a.apiName > b.apiName ? 1 : 0,
  );

  const entries: string[] = [];
  const imports: string[] = [];

  for (const actionType of actionTypes) {
    const constant = yield* actionConstant(actionType.apiName);

    imports.push(constant);

    entries.push(
      `  ${JSON.stringify(actionType.rid)}: { action: ${constant}, displayName: ${JSON.stringify(yield* displayName(actionType))} },\n`,
    );
  }

  return {
    imports,
    text: `export const $actionTypesByRid = {\n${entries.join('')}} as const;\n`,
  };
}

function environments(deployment: ModuleEnvironments): ModuleExport {
  const entries = ENVIRONMENTS.flatMap((name) => {
    const environment = deployment[name];

    return environment
      ? [
          `  ${name}: { baseUrl: ${JSON.stringify(environment.baseUrl)}, workosClientId: ${JSON.stringify(environment.workosClientId)} },\n`,
        ]
      : [];
  });

  return { imports: [], text: `export const $environments = {\n${entries.join('')}} as const;\n` };
}

export function* serviceModuleText(
  metadata: OntologyFullMetadata,
  deployment: ModuleEnvironments,
): Fallible<string, CliError> {
  const exports = [yield* actionTypesByRid(metadata), environments(deployment)];
  const imports = exports.flatMap((part) => part.imports);

  return [
    ...(imports.length > 0 ? [`import { ${imports.join(', ')} } from './index.js';\n`] : []),
    ...exports.map((part) => part.text),
  ].join('\n');
}
