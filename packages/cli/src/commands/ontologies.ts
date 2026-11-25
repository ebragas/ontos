import type { OntologyV2 } from '@osdk/foundry.ontologies';
import { CliError, errorBody } from '../cliError.ts';
import { failureOf } from '../errors.ts';
import { attempt, type AsyncFallible, type Fallible } from '../fallible.ts';
import { dropMetadata } from '../metadataCache.ts';
import { serviceFetch } from '../serviceFetch.ts';
import type { Context } from './types.ts';

export const INSTALL_USAGE = 'install <product> --api-name <name> --display-name <name>';

export function* chooseOntology(
  listed: readonly OntologyV2[],
  apiName: string | undefined,
): Fallible<OntologyV2, CliError> {
  if (listed.length === 0)
    return yield new CliError(
      `The Organization has no Ontology. An admin of the Organization must install one: ontos ${INSTALL_USAGE}`,
    );

  const apiNames = listed.map((ontology) => ontology.apiName);

  if (apiName !== undefined) {
    const chosen = listed.find((ontology) => ontology.apiName === apiName);

    if (chosen) return chosen;

    return yield refusal(
      `The Organization has no Ontology with the API name ${apiName}. It has these: ${apiNames.join(', ')}.`,
      apiNames,
    );
  }

  const [only, ...others] = listed;

  if (only && others.length === 0) return only;

  return yield refusal(
    `The Organization has more than 1 Ontology, so pass --ontology <apiName> with 1 of these: ${apiNames.join(', ')}.`,
    apiNames,
  );
}

export async function* installProduct(
  { target, io, flags, connection }: Context,
  product: string,
): AsyncFallible<OntologyV2, CliError> {
  const { 'api-name': apiName, 'display-name': displayName } = flags;

  if (!apiName || !displayName) return yield new CliError(`Usage: ontos ${INSTALL_USAGE}`);

  const { token } = yield* connection();

  try {
    const bearer = yield* attempt(() => token(), failureOf);

    const response = yield* attempt(
      () =>
        serviceFetch(io)(new URL('/api/ontology-service/v1/ontologies', target.url), {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify({ product, apiName, displayName }),
        }),
      failureOf,
    );

    if (response.status !== 200) {
      const body = yield* errorBody(response);

      return yield new CliError(`The install gave ${response.status}.`, body);
    }

    return yield* attempt(() => response.json() as Promise<OntologyV2>, failureOf);
  } finally {
    dropMetadata(target.url);
  }
}

const refusal = (message: string, ontologies: readonly string[]): CliError =>
  new CliError(message, { message, ontologies });
