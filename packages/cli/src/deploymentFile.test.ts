import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempFolder } from './cli.test-utils.ts';
import { DEFAULT_DEV_PRODUCT_RID, isProductRid, readDeploymentFile } from './deploymentFile.ts';
import { settle } from './fallible.ts';

const VALID_RID = 'ri.ontology.main.ontology.11111111-1111-4111-8111-111111111111';

const VALID_STAGING = {
  baseUrl: 'https://acme-staging.ontos.example',
  workosClientId: 'client_01STAGING',
};

const VALID_PRODUCTION = {
  baseUrl: 'https://acme.ontos.example',
  workosClientId: 'client_01PRODUCTION',
};

function read(content: string) {
  const root = tempFolder({ '.ontology/deployment.json': content });

  return { root, path: join(root, '.ontology/deployment.json'), result: settle(readDeploymentFile(root)) };
}

describe('deploymentFile', () => {
  it('validates product RIDs cleanly', () => {
    expect(isProductRid(DEFAULT_DEV_PRODUCT_RID)).toBe(true);
    expect(isProductRid(VALID_RID)).toBe(true);
    expect(isProductRid('ri.ontology.main.ontology.not-a-uuid')).toBe(false);
    expect(isProductRid('')).toBe(false);
  });

  it('reads a valid deployment file with staging, production, or both', () => {
    const both = read(JSON.stringify({ productRid: VALID_RID, staging: VALID_STAGING, production: VALID_PRODUCTION }));

    expect(both.result).toEqual({
      ok: true,
      value: {
        path: both.path,
        file: { productRid: VALID_RID, staging: VALID_STAGING, production: VALID_PRODUCTION },
      },
    });

    const stagingOnly = read(JSON.stringify({ productRid: VALID_RID, staging: VALID_STAGING }));

    expect(stagingOnly.result).toEqual({
      ok: true,
      value: { path: stagingOnly.path, file: { productRid: VALID_RID, staging: VALID_STAGING } },
    });

    const productionOnly = read(JSON.stringify({ productRid: VALID_RID, production: VALID_PRODUCTION }));

    expect(productionOnly.result).toEqual({
      ok: true,
      value: { path: productionOnly.path, file: { productRid: VALID_RID, production: VALID_PRODUCTION } },
    });
  });

  it('fails when the deployment file does not exist', () => {
    const root = tempFolder();
    const expectedPath = join(root, '.ontology/deployment.json');
    const result = settle(readDeploymentFile(root));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe(`The deployment file ${expectedPath} does not exist.`);
  });

  it('rejects invalid JSON', () => {
    const { path, result } = read('{ not valid json');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain(`${path}: The file is not valid JSON:`);
  });

  it.each([
    ['null', 'null'],
    ['array', '[]'],
    ['string', '"hello"'],
    ['number', '42'],
  ])('rejects a non-object JSON root (%s)', (_label, content) => {
    const { path, result } = read(content);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe(`${path}: The file must hold a JSON object.`);
  });

  it.each([
    ['missing productRid', JSON.stringify({ staging: VALID_STAGING }), 'productRid must be a non-empty string.'],
    [
      'empty productRid',
      JSON.stringify({ productRid: '', staging: VALID_STAGING }),
      'productRid must be a non-empty string.',
    ],
    [
      'non-string productRid',
      JSON.stringify({ productRid: 123, staging: VALID_STAGING }),
      'productRid must be a non-empty string.',
    ],
    [
      'malformed productRid',
      JSON.stringify({ productRid: 'ri.ontology.main.ontology.invalid', staging: VALID_STAGING }),
      'productRid must have the form ri.ontology.main.ontology.<UUID>.',
    ],
  ])('rejects invalid productRid (%s)', (_label, content, expected) => {
    const { path, result } = read(content);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe(`${path}: ${expected}`);
  });

  it('rejects a deployment file with no environments', () => {
    const { path, result } = read(JSON.stringify({ productRid: VALID_RID }));

    expect(result.ok).toBe(false);

    expect(!result.ok && result.error.message).toBe(
      `${path}: The file has no environment. It needs staging, production, or both.`,
    );
  });

  it.each([
    ['non-object staging', { staging: null }, 'staging must be an object.'],
    ['array staging', { staging: [] }, 'staging must be an object.'],
    ['missing baseUrl', { staging: { workosClientId: 'client_1' } }, 'staging.baseUrl must be a non-empty string.'],
    [
      'empty baseUrl',
      { staging: { baseUrl: '', workosClientId: 'client_1' } },
      'staging.baseUrl must be a non-empty string.',
    ],
    [
      'non-https baseUrl',
      { staging: { baseUrl: 'http://acme.ontos.example', workosClientId: 'client_1' } },
      'staging.baseUrl must be an https origin.',
    ],
    [
      'unparseable baseUrl',
      { staging: { baseUrl: 'not-a-url', workosClientId: 'client_1' } },
      'staging.baseUrl must be an https origin.',
    ],
    [
      'baseUrl with path',
      { staging: { baseUrl: 'https://acme.ontos.example/api', workosClientId: 'client_1' } },
      'staging.baseUrl must be an https origin.',
    ],
    [
      'missing workosClientId',
      { production: { baseUrl: 'https://acme.ontos.example' } },
      'production.workosClientId must be a non-empty string.',
    ],
    [
      'empty workosClientId',
      { production: { baseUrl: 'https://acme.ontos.example', workosClientId: '' } },
      'production.workosClientId must be a non-empty string.',
    ],
    [
      'invalid workosClientId prefix',
      { production: { baseUrl: 'https://acme.ontos.example', workosClientId: 'bad_123' } },
      'production.workosClientId must start with client_.',
    ],
  ])('rejects invalid environment settings (%s)', (_label, envBlock, expected) => {
    const { path, result } = read(JSON.stringify({ productRid: VALID_RID, ...envBlock }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe(`${path}: ${expected}`);
  });
});
