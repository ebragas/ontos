import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convert } from '@ericbragas/ontos-service/convert';
import type { PublishedFunctions } from '@ericbragas/ontos-service/publish';
import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import { describe, expect, it } from 'vitest';
import { orThrow } from '../fallible.ts';
import { manifestFields as fallibleManifestFields, ontologyHash } from './sdkPackage.ts';
import { serviceModuleText as fallibleServiceModuleText } from './serviceModule.ts';
import { OSDK_SET as SET, twinIr } from '../apps.test-utils.ts';
import { ROOT } from '../cli.test-utils.ts';
import { hashOf, MANIFEST_FIELDS, withStaging } from './sdkPackage.test-utils.ts';

const METADATA: OntologyFullMetadata = {
  ontology: { apiName: 'gate', displayName: 'gate', description: '', rid: 'ri.ontology.main.ontology.1' },
  objectTypes: {},
  actionTypes: {},
  actionTypesFullMetadata: {},
  queryTypes: {},
  interfaceTypes: {},
  sharedPropertyTypes: {},
  valueTypes: {},
};

const manifestFields = (...args: Parameters<typeof fallibleManifestFields>) => orThrow(fallibleManifestFields(...args));

const serviceModuleText = (...args: Parameters<typeof fallibleServiceModuleText>) =>
  orThrow(fallibleServiceModuleText(...args));

const MODULE = serviceModuleText(METADATA, withStaging());

describe('the ontologyHash of the Ontology SDK package', () => {
  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: the same metadata, OSDK set, and manifest fields give the same hash, in any key order', () => {
    expect(manifestFields(SET)).toEqual(MANIFEST_FIELDS);

    const hash = ontologyHash(METADATA, SET, manifestFields(SET), MODULE);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ontologyHash(METADATA, SET, manifestFields(SET), MODULE)).toBe(hash);

    const reversed = Object.fromEntries(Object.entries(manifestFields(SET)).reverse());

    expect(ontologyHash(METADATA, SET, reversed, MODULE)).toBe(hash);
    expect(hashOf(METADATA)).toBe(hash);
  });

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: a change of the manifest fields gives a new hash, so the first publish on a new manifest publishes a new version', () => {
    const hash = ontologyHash(METADATA, SET, manifestFields(SET), MODULE);

    expect(
      ontologyHash(METADATA, SET, { ...manifestFields(SET), peerDependencies: { '@osdk/client': '^2.0.0' } }, MODULE),
    ).not.toBe(hash);

    expect(
      ontologyHash(METADATA, SET, { ...manifestFields(SET), devDependencies: { typescript: '^6.0.0' } }, MODULE),
    ).not.toBe(hash);
  });

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: a change of the ontology-service module text gives a new hash, so a CLI change to the module alone publishes a new version', () => {
    const hash = ontologyHash(METADATA, SET, manifestFields(SET), MODULE);

    expect(ontologyHash(METADATA, SET, manifestFields(SET), `${MODULE}export const $more = 1;\n`)).not.toBe(hash);
  });

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: a change of 1 WorkOS client ID or 1 base URL gives a new hash, so the published SDK never keeps an old value', () => {
    const hash = ontologyHash(METADATA, SET, manifestFields(SET), MODULE);

    expect(ontologyHash(METADATA, SET, manifestFields(SET), serviceModuleText(METADATA, withStaging()))).toBe(hash);

    expect(
      ontologyHash(METADATA, SET, manifestFields(SET), serviceModuleText(METADATA, withStaging('client_staging_2'))),
    ).not.toBe(hash);

    const production = { ...withStaging().production, baseUrl: 'https://gate2.ontos.example' };

    expect(
      ontologyHash(METADATA, SET, manifestFields(SET), serviceModuleText(METADATA, { ...withStaging(), production })),
    ).not.toBe(hash);
  });

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: the manifest fields declare the @osdk/client of the OSDK set as an exact peer dependency, and no dependencies', () => {
    const fields = manifestFields({ ...SET, '@osdk/client': '2.81.0' });

    expect(fields.peerDependencies).toEqual({ '@osdk/client': '2.81.0' });
    expect(fields).not.toHaveProperty('dependencies');
  });

  it('an OSDK set with no @osdk/client gives no manifest, because the Ontology SDK imports it', () => {
    const withoutClient = Object.fromEntries(Object.entries(SET).filter(([name]) => name !== '@osdk/client'));

    expect(() => manifestFields(withoutClient)).toThrow(
      'The app installs no @osdk/client. The Ontology SDK declares it as a peer dependency, at the version of the OSDK set.',
    );
  });

  it('ontology/functions/query-functions#ontology-metadata ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: an app with a Query Function gives the same hash at 2 Ontology version numbers, so staging and production share 1 package', () => {
    const twin = JSON.parse(
      readFileSync(join(ROOT, 'packages/service/twin/functions/0.4.0.json'), 'utf8'),
    ) as PublishedFunctions;

    const query = {
      locator: { type: 'typescript', typescript: { functionName: 'accountLabel' } },
      inputs: [{ name: 'client', dataType: { type: 'client', client: {} } }],
      output: { type: 'single', single: { dataType: { type: 'string', string: {} } } },
      customTypes: {},
      documentation: 'The label of an account.',
    };

    const request = {
      ir: twinIr('0.4.0'),
      osdkSet: SET,
      functions: { ...twin, discovered: [...twin.discovered, query] },
      validateOnly: false,
    } as Parameters<typeof convert>[0];

    const hashAt = (version: number) => {
      const { metadata } = orThrow(
        convert(request, 'ri.ontology.main.ontology.11111111-1111-4111-8111-111111111111', version),
      );

      return ontologyHash(metadata, SET, manifestFields(SET), serviceModuleText(metadata, withStaging()));
    };

    expect(
      Object.keys(
        orThrow(convert(request, 'ri.ontology.main.ontology.11111111-1111-4111-8111-111111111111', 1)).metadata
          .queryTypes,
      ),
    ).toEqual(['accountLabel']);

    expect(hashAt(12)).toBe(hashAt(3));
  });

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: domain files add the ./domain export and enter ontologyHash in sorted path order, while apps without domain/ keep the exact existing manifest and hash', () => {
    const baseFields = manifestFields(SET);

    expect(baseFields.exports).not.toHaveProperty('./domain');

    const withDomainFields = manifestFields(SET, true);

    expect(withDomainFields.exports).toEqual({
      ...baseFields.exports,
      './domain': { types: './dist/domain/index.d.ts', import: './dist/domain/index.js' },
    });

    expect(withDomainFields).not.toHaveProperty('dependencies');

    const a = { path: 'index.ts', bytes: Buffer.from("export * from './money.ts';\n") };
    const b = { path: 'money.ts', bytes: Buffer.from('export const ZERO = 0;\n') };
    const withoutDomain = ontologyHash(METADATA, SET, baseFields, MODULE);
    const withDomain = ontologyHash(METADATA, SET, withDomainFields, MODULE, [a, b]);
    const reversedOrder = ontologyHash(METADATA, SET, withDomainFields, MODULE, [b, a]);

    const edited = ontologyHash(METADATA, SET, withDomainFields, MODULE, [
      a,
      { path: 'money.ts', bytes: Buffer.from('export const ZERO = 1;\n') },
    ]);

    expect(withDomain).not.toBe(withoutDomain);
    expect(reversedOrder).toBe(withDomain);
    expect(edited).not.toBe(withDomain);
  });
});
