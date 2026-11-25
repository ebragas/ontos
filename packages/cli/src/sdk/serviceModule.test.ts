import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import { describe, expect, it } from 'vitest';
import { orThrow } from '../fallible.ts';
import { serviceModuleText as fallibleServiceModuleText } from './serviceModule.ts';

const serviceModuleText = (...args: Parameters<typeof fallibleServiceModuleText>) =>
  orThrow(fallibleServiceModuleText(...args));

// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- serviceModuleText reads only the Action Types, so the test gives partial metadata with partial Action Types.
const metadata = (actionTypes: Record<string, unknown>) => ({ actionTypes }) as unknown as OntologyFullMetadata;

const environment = (baseUrl: string, workosClientId: string) => ({
  baseUrl,
  workosClientId,
  signInMethods: ['google' as const],
  trustedGithubRepository: 'example/x-ontology',
  trustedGithubEnvironment: 'ontology-production',
});

const PRODUCTION = { production: environment('https://x.ontos.example', 'client_production') };

describe('the ontology-service module', () => {
  it('ontology/ontology-sdk/ontology-sdk#contract: an Ontology with no Action Types gives an empty $actionTypesByRid and imports nothing', () => {
    expect(serviceModuleText(metadata({}), PRODUCTION)).toMatch(
      /^export const \$actionTypesByRid = \{\n\} as const;\n\nexport const \$environments/,
    );
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: a deployment with only production, such as gate, gives $environments with only production, and only its base URL and WorkOS client ID', () => {
    expect(serviceModuleText(metadata({}), PRODUCTION).split('\n\n')[1]).toBe(`export const $environments = {
  production: { baseUrl: "https://x.ontos.example", workosClientId: "client_production" },
} as const;
`);
  });

  it('ontology/ontology-sdk/ontology-sdk#contract, ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: $environments gives staging before production, in any key order of the deployment file', () => {
    const deployment = {
      production: environment('https://x.ontos.example', 'client_production'),
      staging: environment('https://x-staging.ontos.example', 'client_staging'),
    };

    expect(serviceModuleText(metadata({}), deployment).split('\n\n')[1]).toBe(`export const $environments = {
  staging: { baseUrl: "https://x-staging.ontos.example", workosClientId: "client_staging" },
  production: { baseUrl: "https://x.ontos.example", workosClientId: "client_production" },
} as const;
`);
  });

  it('an Action Type with no display name stops the module, because the module gives each display name', () => {
    expect(() =>
      serviceModuleText(
        metadata({ 'com.x.do-it': { apiName: 'com.x.do-it', rid: 'ri.actions.main.action-type.1' } }),
        PRODUCTION,
      ),
    ).toThrow(
      'Action Type com.x.do-it has no display name. The ontology-service module of the Ontology SDK holds the display name of each Action Type.',
    );
  });

  it('refuses Action Type apiName values that are not valid TypeScript identifiers', () => {
    expect(() =>
      serviceModuleText(
        metadata({
          injected: {
            apiName: 'com.x.foo}; process.exit(1); //',
            rid: 'ri.actions.main.action-type.1',
            displayName: 'Injected',
          },
        }),
        PRODUCTION,
      ),
    ).toThrow(/invalid TypeScript identifier/);
  });
});
