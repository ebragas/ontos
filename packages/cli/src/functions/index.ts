import type { PublishedFunctions, PublishRequest } from '@ericbragas/ontos-service/publish';
import type { App } from '../app.ts';
import type { CliError } from '../cliError.ts';
import type { AsyncFallible } from '../fallible.ts';
import { bundleFunctions } from './bundle.ts';
import { discoverFunctions, hasFunctions } from './discover.ts';

export async function* appFunctions(
  app: App,
  ir: PublishRequest['ir'],
): AsyncFallible<PublishedFunctions | undefined, CliError> {
  if (!hasFunctions(app.functions)) return undefined;

  const { projectFolder, discovered } = yield* discoverFunctions(app.functions, ir);

  return { discovered, bundle: yield* bundleFunctions(projectFolder, discovered) };
}
