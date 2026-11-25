import { ApiError, type Fallible } from '../errors/index.ts';
import type { ChooseOntology, RouteResult } from '../handler/index.ts';
import type { JsonValue } from '../ontology/index.ts';

const CALL_AGAIN = 'Call this tool again, and set `ontology` to 1 of the API names in `parameters.ontologies`.';

const ADVICE: Readonly<Record<string, string>> = {
  'OntologyService:NoOrganization':
    'Your sign-in has no Organization. Join or create an Organization, then sign in again.',
  'OntologyService:NoOntologyInstalled':
    'Your Organization has no Ontology. An admin of your Organization must install one.',
  'OntologyService:OntologyRequired': `Your Organization has more than 1 Ontology. ${CALL_AGAIN}`,
  OntologyNotFound: `Your Organization has no Ontology with this API name. ${CALL_AGAIN}`,
};

export function adviceOf(body: JsonValue): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;

  const { errorName } = body as Readonly<Record<string, JsonValue>>;

  return typeof errorName === 'string' && Object.hasOwn(ADVICE, errorName) ? ADVICE[errorName] : undefined;
}

export function chooseOntology({
  requested,
  listWhenSeveral,
}: {
  readonly requested: JsonValue | undefined;
  readonly listWhenSeveral: boolean;
}): ChooseOntology {
  return function* (ontologies): Fallible<string | RouteResult, ApiError> {
    const [first, ...others] = ontologies;

    if (first === undefined) return yield new ApiError(404, 'OntologyService:NoOntologyInstalled');

    const apiNames = ontologies.map((ontology) => ontology.apiName);

    if (requested !== undefined && requested !== null && requested !== '') {
      const named = ontologies.find((ontology) => ontology.apiName === requested);

      if (named === undefined)
        return yield new ApiError(404, 'OntologyNotFound', {
          apiName: typeof requested === 'string' ? requested : JSON.stringify(requested),
          ontologies: apiNames,
        });

      return named.rid;
    }

    if (others.length === 0) return first.rid;

    if (!listWhenSeveral) return yield new ApiError(400, 'OntologyService:OntologyRequired', { ontologies: apiNames });

    return {
      status: 200,
      body: { ontologies: ontologies.map(({ apiName, displayName }) => ({ apiName, displayName })) },
    };
  };
}
