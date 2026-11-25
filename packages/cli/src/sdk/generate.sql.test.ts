import { execFileSync } from 'node:child_process';
import { ontologyMetadata } from '@ericbragas/ontos-service/convert';
import { orThrow } from '../fallible.ts';
import type { PublishRequest } from '@ericbragas/ontos-service/publish';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { TEST_APP } from '../../../../tools/packaging/testService.ts';
import { generatorArgs } from './generate.ts';
import { linkedApp, TWIN_FUNCTIONS } from '../apps.test-utils.ts';
import { cli, ROOT, stubFetch, tempFolder, withoutDescriptionWarnings } from '../cli.test-utils.ts';
import { localGate, toLocal } from '../sql.test-utils.ts';

const local = localGate();
const SDK = 'ontology/osdk-output/ontology';

function sources(folder: string): Record<string, string> {
  const files = readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    .filter((path) => !path.startsWith('dist'));

  return Object.fromEntries(files.sort().map((path) => [path, readFileSync(join(folder, path), 'utf8')]));
}

describe('generate-osdk against node.ts', () => {
  let comparison: {
    root: string;
    noneCalls: unknown[];
    generated: Awaited<ReturnType<typeof cli>>;
    validated: Awaited<ReturnType<typeof cli>>;
    body: PublishRequest;
    metadata: unknown;
    reference: string;
  };

  beforeAll(async () => {
    const root = linkedApp();
    const none = stubFetch();

    const generated = await cli(['generate-osdk'], { cwd: root, fetch: none });

    const fetch = stubFetch(toLocal);

    const validated = await cli(['validate', ...local.flags()], { cwd: root, fetch, env: local.service.oidcEnv });

    const body = JSON.parse(
      fetch.calls.find(({ url }) => url.endsWith('/api/ontology-service/v1/publish'))?.body ?? '{}',
    ) as PublishRequest;

    const { metadata } = validated.output as { metadata: unknown };
    const reference = tempFolder();
    const ontologyPath = join(reference, 'ontology-metadata.json');

    writeFileSync(ontologyPath, JSON.stringify(metadata));

    const osdkBin = join(ROOT, 'node_modules/@osdk/cli/bin/osdk.mjs');

    execFileSync(process.execPath, [osdkBin, ...generatorArgs(ontologyPath, join(reference, 'sdk'))], {
      cwd: root,
      stdio: 'pipe',
    });

    comparison = { root, noneCalls: none.calls, generated, validated, body, metadata, reference };
  }, 60_000);

  it('ontology/ontology-sdk/ontology-sdk#contract: generate-osdk runs with no fetch, and its Ontology SDK equals the Ontology SDK of the validateOnly publish response for the same twin IR and Functions, byte for byte, with only the package files and the ontology-service module added', () => {
    const { root, noneCalls, generated, validated, body, metadata, reference } = comparison;

    expect(generated.stderr).toBe('');
    expect(noneCalls).toEqual([]);
    expect(withoutDescriptionWarnings(validated.stderr)).toBe('');
    expect(body.functions?.discovered).toHaveLength(TWIN_FUNCTIONS.length);

    expect(
      orThrow(
        ontologyMetadata(
          { ir: body.ir, osdkSet: body.osdkSet, ...(body.functions ? { functions: body.functions } : {}) },
          TEST_APP.productRid,
        ),
      ),
    ).toEqual(metadata);

    const {
      'ontology-service.ts': module,
      'package.json': manifest,
      'tsconfig.json': tsconfig,
      ...osdk
    } = sources(join(root, SDK));

    expect(Object.keys(osdk)).toContain('ontology/actions/closeAccountAction.ts');
    expect(osdk).toEqual(sources(join(reference, 'sdk')));
    expect([module, manifest, tsconfig]).not.toContain(undefined);
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: the metadata of generate-osdk, made with no fetch and the product RID, equals the fullMetadata of an installation at another RID, except the Ontology RID', async () => {
    const root = linkedApp();
    const none = stubFetch();

    expect((await cli(['generate-osdk'], { cwd: root, fetch: none })).stderr).toBe('');

    expect(none.calls).toEqual([]);

    expect(readFileSync(join(root, SDK, 'OntologyMetadata.ts'), 'utf8')).toContain(
      `export const $ontologyRid = '${TEST_APP.productRid}';`,
    );

    const fetch = stubFetch(toLocal);

    const published = await cli(['publish', ...local.flags()], { cwd: root, fetch, env: local.service.oidcEnv });

    expect(withoutDescriptionWarnings(published.stderr)).toBe('');

    const body = JSON.parse(
      fetch.calls.filter(({ url }) => url.endsWith('/api/ontology-service/v1/publish')).at(-1)?.body ?? '{}',
    ) as PublishRequest;

    const authorization = `Bearer ${await local.service.issuer.workos({ role: 'admin' })}`;

    const installed = await globalThis.fetch(`${local.service.url}/api/ontology-service/v1/ontologies`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ product: 'app', apiName: 'second', displayName: 'second' }),
    });

    const { rid } = (await installed.json()) as { rid: string };

    expect(rid).not.toBe(TEST_APP.productRid);

    const served = await (
      await globalThis.fetch(`${local.service.url}/api/v2/ontologies/${rid}/fullMetadata`, {
        headers: { authorization },
      })
    ).json();

    const generated = orThrow(
      ontologyMetadata(
        { ir: body.ir, osdkSet: body.osdkSet, ...(body.functions ? { functions: body.functions } : {}) },
        TEST_APP.productRid,
      ),
    );

    expect(served).toEqual({
      ...generated,
      ontology: { rid, apiName: 'second', displayName: 'second', description: '' },
    });
  });
});
