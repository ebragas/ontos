import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import { createHash } from 'node:crypto';
import type { DomainFile } from './domain.ts';
import { orThrow } from '../fallible.ts';
import { serviceModuleText } from './serviceModule.ts';
import { GATE_DEPLOYMENT_FILE, notesApp, OSDK_SET } from '../apps.test-utils.ts';
import { GATE_STAGING_URL } from '../sql.test-utils.ts';

export const NAME = '@ontos/app-ontology-sdk';

export const withStaging = (stagingClientId = 'client_staging') => ({
  vercelProjectId: 'prj_test',
  neonProjectId: 'calm-river-12345678',
  productRid: (JSON.parse(GATE_DEPLOYMENT_FILE) as { productRid: string }).productRid,
  allowPreReleases: true,
  staging: {
    baseUrl: GATE_STAGING_URL,
    workosClientId: stagingClientId,
    trustedGithubRepository: 'example/app-ontology',
    trustedGithubEnvironment: 'ontology-staging',
  },
  production: {
    baseUrl: 'https://app.ontos.example',
    workosClientId: 'client_production',
    trustedGithubRepository: 'example/app-ontology',
    trustedGithubEnvironment: 'ontology-production',
  },
});

export const stagingApp = (stagingClientId?: string, extraFiles: Readonly<Record<string, string>> = {}): string =>
  notesApp({ '.ontology/deployment.json': JSON.stringify(withStaging(stagingClientId)), ...extraFiles });

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;

  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortedJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

export const MANIFEST_FIELDS = {
  type: 'module',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    './ontology-service': { types: './dist/ontology-service.d.ts', import: './dist/ontology-service.js' },
  },
  scripts: { build: 'tsc' },
  peerDependencies: { '@osdk/client': '2.92.0' },
  devDependencies: { typescript: '^5.0.0' },
  publishConfig: { registry: 'https://npm.pkg.github.com', tag: 'staging' },
};

export const MANIFEST_FIELDS_WITH_DOMAIN = {
  ...MANIFEST_FIELDS,
  exports: {
    ...MANIFEST_FIELDS.exports,
    './domain': { types: './dist/domain/index.d.ts', import: './dist/domain/index.js' },
  },
};

export const hashOf = (metadata: unknown, deployment = withStaging(), domain?: readonly DomainFile[]): string => {
  const manifest = domain ? MANIFEST_FIELDS_WITH_DOMAIN : MANIFEST_FIELDS;
  const serviceModule = orThrow(serviceModuleText(metadata as OntologyFullMetadata, deployment));

  const payload = domain
    ? {
        metadata,
        osdkSet: OSDK_SET,
        manifest,
        serviceModule,
        domain: [...domain]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map(({ path, bytes }) => [path, bytes.toString('base64')]),
      }
    : { metadata, osdkSet: OSDK_SET, manifest, serviceModule };

  return createHash('sha256').update(sortedJson(payload)).digest('hex');
};
