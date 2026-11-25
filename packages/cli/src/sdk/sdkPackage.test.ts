import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import { describe, expect, it } from 'vitest';
import type { App } from '../app.ts';
import { OSDK_SET as SET } from '../apps.test-utils.ts';
import { stubRegistry } from '../cli.test-utils.ts';
import { orThrow, settle } from '../fallible.ts';
import { manifestFields, ontologyHash, releaseSdkPackage, sdkPackageConfig } from './sdkPackage.ts';
import { withStaging } from './sdkPackage.test-utils.ts';
import { serviceModuleText } from './serviceModule.ts';

const METADATA: OntologyFullMetadata = {
  ontology: { apiName: 'notes', displayName: 'notes', description: '', rid: 'ri.ontology.main.ontology.1' },
  objectTypes: {},
  actionTypes: {},
  actionTypesFullMetadata: {},
  queryTypes: {},
  interfaceTypes: {},
  sharedPropertyTypes: {},
  valueTypes: {},
};

describe('SDK package registry and scope configuration', () => {
  it('uses default registry and @ontos scope when env variables are unset or blank', () => {
    expect(orThrow(sdkPackageConfig('notes', {}))).toEqual({
      name: '@ontos/notes-ontology-sdk',
      registry: 'https://npm.pkg.github.com',
    });

    expect(orThrow(sdkPackageConfig('notes', { ONTOS_SDK_REGISTRY: '   ', ONTOS_SDK_PACKAGE_SCOPE: '' }))).toEqual({
      name: '@ontos/notes-ontology-sdk',
      registry: 'https://npm.pkg.github.com',
    });
  });

  it('allows overriding the registry via ONTOS_SDK_REGISTRY', () => {
    const { registry } = orThrow(sdkPackageConfig('notes', { ONTOS_SDK_REGISTRY: 'https://registry.npmjs.org' }));

    expect(registry).toBe('https://registry.npmjs.org');

    expect(orThrow(sdkPackageConfig('notes', { ONTOS_SDK_REGISTRY: 'http://127.0.0.1:4873' })).registry).toBe(
      'http://127.0.0.1:4873',
    );

    expect(orThrow(manifestFields(SET, false, registry)).publishConfig).toEqual({
      registry: 'https://registry.npmjs.org',
      tag: 'staging',
    });
  });

  it('refuses an invalid ONTOS_SDK_REGISTRY', () => {
    for (const value of ['not-a-url', 'ftp://registry.example.com']) {
      expect(settle(sdkPackageConfig('notes', { ONTOS_SDK_REGISTRY: value }))).toEqual({
        ok: false,
        error: expect.objectContaining({ message: 'ONTOS_SDK_REGISTRY must be an http:// or https:// URL.' }),
      });
    }
  });

  it('refuses an ONTOS_SDK_REGISTRY URL with embedded credentials', () => {
    for (const value of [
      'https://user:pass@registry.example.com',
      'https://token@registry.example.com',
      'http://:secret@127.0.0.1:4873',
    ]) {
      expect(settle(sdkPackageConfig('notes', { ONTOS_SDK_REGISTRY: value }))).toEqual({
        ok: false,
        error: expect.objectContaining({ message: 'ONTOS_SDK_REGISTRY must not contain embedded credentials.' }),
      });
    }
  });

  it('allows overriding and normalizing the scope via ONTOS_SDK_PACKAGE_SCOPE', () => {
    expect(orThrow(sdkPackageConfig('notes', { ONTOS_SDK_PACKAGE_SCOPE: '@acme' })).name).toBe(
      '@acme/notes-ontology-sdk',
    );

    expect(orThrow(sdkPackageConfig('notes', { ONTOS_SDK_PACKAGE_SCOPE: 'acme' })).name).toBe(
      '@acme/notes-ontology-sdk',
    );

    expect(orThrow(sdkPackageConfig('notes', { ONTOS_SDK_PACKAGE_SCOPE: 'my-org.team' })).name).toBe(
      '@my-org.team/notes-ontology-sdk',
    );
  });

  it('refuses an invalid ONTOS_SDK_PACKAGE_SCOPE', () => {
    for (const value of ['@Bad_Caps', 'bad/scope', '@-leading', '@', '@my..org', 'foo..bar']) {
      expect(settle(sdkPackageConfig('notes', { ONTOS_SDK_PACKAGE_SCOPE: value }))).toEqual({
        ok: false,
        error: expect.objectContaining({
          message: 'ONTOS_SDK_PACKAGE_SCOPE must be a valid npm scope, such as @my-org.',
        }),
      });
    }
  });

  it('passes the resolved ONTOS_SDK_REGISTRY to registry.find and registry.tag', async () => {
    const customRegistry = 'https://registry.example.com/npm';
    const deployment = withStaging();
    const fields = orThrow(manifestFields(SET, false, customRegistry));
    const hash = ontologyHash(METADATA, SET, fields, orThrow(serviceModuleText(METADATA, deployment)));
    const name = '@acme/notes-ontology-sdk';
    const registry = stubRegistry({ [name]: [{ version: '0.0.7', ontologyHash: hash }] });

    const context = {
      io: { env: { ONTOS_SDK_REGISTRY: customRegistry, ONTOS_SDK_PACKAGE_SCOPE: '@acme' }, registry },
      target: { app: 'notes', environment: 'production' as const },
    };

    const app: App = {
      root: '/tmp/notes-app',
      configFile: 'ontos.yml',
      apiNamespace: 'com.example.notes',
      osdkOutput: undefined,
      ontology: '/tmp/notes-app/ontology',
      functions: undefined,
    };

    const response = { version: 1, changes: [], metadata: METADATA };

    const result = await settle(releaseSdkPackage(context, app, deployment, response, SET));

    expect(result).toEqual({ ok: true, value: { name, version: '0.0.7', ontologyHash: hash, action: 'tagged' } });

    expect(registry.findCalls).toEqual([{ name, ontologyHash: hash, cwd: '/tmp/notes-app', registry: customRegistry }]);

    expect(registry.tagCalls).toEqual([
      { name, version: '0.0.7', tag: 'production', cwd: '/tmp/notes-app', registry: customRegistry },
      { name, version: '0.0.7', tag: 'latest', cwd: '/tmp/notes-app', registry: customRegistry },
    ]);
  });
});
