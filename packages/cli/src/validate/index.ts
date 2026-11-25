import { readApp } from '../app.ts';
import { CliError } from '../cliError.ts';
import type { Context } from '../commands/types.ts';
import type { AsyncFallible } from '../fallible.ts';
import { publishApp } from '../publish.ts';
import { validateLocal, type ValidateOutput } from './local.ts';
import { readGitValidationMode } from './mode.ts';

const LOCAL_PRODUCTION_REFUSAL =
  'ontos validate --local runs the staging settings of .ontology/deployment.json, so it does not take --env production.';

export async function* validateApp(context: Context): AsyncFallible<ValidateOutput, CliError> {
  const { flags } = context;

  if (flags.local && flags.base !== undefined) {
    return yield new CliError('ontos validate does not take both --local and --base.');
  }

  if (flags.local) {
    if (flags.url !== undefined)
      return yield new CliError('ontos validate --local starts its own local service, so it does not take --url.');

    if (flags['test-user'])
      return yield new CliError(
        'ontos validate --local starts its own local service, so it does not take --test-user.',
      );

    if (flags.env === 'production') return yield new CliError(LOCAL_PRODUCTION_REFUSAL);

    const app = yield* readApp(context.io.cwd);

    return yield* validateLocal(context, app);
  }

  if (flags.base !== undefined) {
    if (flags.base === '') return yield new CliError('--base needs a Git commit or ref: ontos validate --base <ref>');

    const app = yield* readApp(context.io.cwd);
    const mode = yield* readGitValidationMode(app, flags.base);

    if (mode.kind === 'mixed') {
      const message = `This pull request changes both the pinned CLI release (${mode.fromRelease} to ${mode.toRelease}) and the Ontology (${mode.ontologyFiles.join(', ')}). Split this into 2 pull requests: move the release first, then change the Ontology.`;

      return yield new CliError(message, {
        message,
        fromRelease: mode.fromRelease,
        toRelease: mode.toRelease,
        files: mode.ontologyFiles,
      });
    }

    if (mode.kind === 'local') {
      if (flags.env === 'production') return yield new CliError(LOCAL_PRODUCTION_REFUSAL);

      return yield* validateLocal(context, app);
    }
  }

  return yield* publishApp(context, true);
}
