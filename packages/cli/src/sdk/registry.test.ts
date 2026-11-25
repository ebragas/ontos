import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settle, type AsyncFallible } from '../fallible.ts';
import type { CliError } from '../cliError.ts';
import type { Registry } from '../io.ts';
import { npmRegistry as registry } from './sdkPackage.ts';
import { once, tempFolder, warm } from '../cli.test-utils.ts';

const NAME = '@ontos/gate-ontology-sdk';

async function value<T>(run: AsyncFallible<T, CliError>): Promise<T> {
  const result = await settle(run);

  if (!result.ok) throw result.error;

  return result.value;
}

const npmRegistry = {
  find: (...args: Parameters<Registry['find']>) => value(registry.find(...args)),
  publish: (...args: Parameters<Registry['publish']>) => value(registry.publish(...args)),
  tag: (...args: Parameters<Registry['tag']>) => value(registry.tag(...args)),
};

interface Stored {
  versions: Record<string, Record<string, unknown>>;
  tarballs: Record<string, Buffer>;
  tags: Record<string, string>;
}

const read = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(chunk as Buffer);

  return Buffer.concat(chunks).toString('utf8');
};

describe('the npm adapter of the package registry', () => {
  const packages = new Map<string, Stored>();

  const server = createServer((request, response) => {
    void (async () => {
      const url = decodeURIComponent(request.url ?? '/');
      const port = (server.address() as AddressInfo).port;
      const tag = /^\/-\/package\/(.+)\/dist-tags\/(.+)$/.exec(url);

      if (tag && request.method === 'PUT') {
        const [, name = '', label = ''] = tag;
        const stored = packages.get(name);

        if (!stored) return response.writeHead(404).end('{}');

        stored.tags[label] = JSON.parse(await read(request)) as string;

        return response.writeHead(201, { 'content-type': 'application/json' }).end('{"ok":true}');
      }

      const tags = /^\/-\/package\/(.+)\/dist-tags$/.exec(url);

      if (tags && request.method === 'GET') {
        const stored = packages.get(tags[1] ?? '');

        return stored
          ? response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stored.tags))
          : response.writeHead(404).end('{}');
      }

      const tarball = /^\/(.+)\/-\/(.+\.tgz)$/.exec(url);

      if (tarball && request.method === 'GET') {
        const data = packages.get(tarball[1] ?? '')?.tarballs[tarball[2] ?? ''];

        return data
          ? response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(data)
          : response.writeHead(404).end();
      }

      const name = url.slice(1);

      if (request.method === 'PUT') {
        const body = JSON.parse(await read(request)) as {
          versions: Record<string, Record<string, unknown>>;
          _attachments: Record<string, { data: string }>;
          'dist-tags': Record<string, string>;
        };

        const stored = packages.get(name) ?? { versions: {}, tarballs: {}, tags: {} };

        for (const [file, { data }] of Object.entries(body._attachments))
          stored.tarballs[file.split('/').at(-1) ?? file] = Buffer.from(data, 'base64');

        for (const [version, manifest] of Object.entries(body.versions)) {
          const file = `${name.split('/').at(-1) ?? name}-${version}.tgz`;

          stored.versions[version] = {
            ...manifest,
            dist: { ...(manifest['dist'] as object), tarball: `http://localhost:${port}/${name}/-/${file}` },
          };
        }

        Object.assign(stored.tags, body['dist-tags']);

        packages.set(name, stored);

        return response.writeHead(201, { 'content-type': 'application/json' }).end('{"ok":true}');
      }

      const stored = packages.get(name);

      if (!stored) return response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found"}');

      return response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ name, versions: stored.versions, 'dist-tags': stored.tags }));
    })();
  });

  let app = '';
  let registryUrl = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));

    const { port } = server.address() as AddressInfo;

    registryUrl = `http://localhost:${port}/`;

    app = tempFolder({
      'package.json': '{"name":"app","private":true}',
      '.npmrc': `@ontos:registry=${registryUrl}\n//localhost:${port}/:_authToken=test\n`,
    });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const folder = (version: string, ontologyHash: string, tag?: string): string => {
    const path = tempFolder();

    mkdirSync(path, { recursive: true });

    writeFileSync(
      join(path, 'package.json'),
      JSON.stringify({ name: NAME, version, type: 'module', ontologyHash, ...(tag ? { publishConfig: { tag } } : {}) }),
    );

    writeFileSync(join(path, 'index.js'), 'export {};\n');

    return path;
  };

  const lifecycle = once(async () => {
    const before = await npmRegistry.find(NAME, 'a'.repeat(64), app, registryUrl);

    await npmRegistry.publish(folder('0.0.7', 'a'.repeat(64)), app);

    await npmRegistry.publish(folder('0.0.9', 'b'.repeat(64)), app);

    await npmRegistry.publish(folder('0.0.10', 'a'.repeat(64)), app);

    const found = {
      a: await npmRegistry.find(NAME, 'a'.repeat(64), app, registryUrl),
      b: await npmRegistry.find(NAME, 'b'.repeat(64), app, registryUrl),
      c: await npmRegistry.find(NAME, 'c'.repeat(64), app, registryUrl),
    };

    await npmRegistry.tag(NAME, '0.0.7', 'production', app, registryUrl);

    return { before, found, productionTag: packages.get(NAME)?.tags['production'] };
  });

  beforeAll(async () => {
    await warm(lifecycle);
  }, 120_000);

  describe('full lifecycle', () => {
    let result: Awaited<ReturnType<typeof lifecycle>>;

    beforeAll(async () => {
      result = await lifecycle();
    });

    it('npm view, npm pack, npm publish, and npm dist-tag add find a version by its ontologyHash, newest first, and move the production tag', () => {
      expect(result.before).toBeUndefined();
      expect(result.found.a).toBe('0.0.10');
      expect(result.found.b).toBe('0.0.9');
      expect(result.found.c).toBeUndefined();
      expect(result.productionTag).toBe('0.0.7');
    });
  });

  describe('dist-tag publishing', () => {
    let tagsAfterLatest: Record<string, string> | undefined;
    let tagsAfterStaging: Record<string, string> | undefined;
    let foundA: string | undefined;
    let foundB: string | undefined;

    beforeAll(async () => {
      packages.delete(NAME);

      await npmRegistry.publish(folder('0.0.1', 'a'.repeat(64)), app);

      tagsAfterLatest = { ...packages.get(NAME)?.tags };

      await npmRegistry.publish(folder('0.0.2', 'b'.repeat(64), 'staging'), app);

      tagsAfterStaging = { ...packages.get(NAME)?.tags };

      foundA = await npmRegistry.find(NAME, 'a'.repeat(64), app, registryUrl);

      foundB = await npmRegistry.find(NAME, 'b'.repeat(64), app, registryUrl);
    });

    it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: npm publish gives the dist-tag of publishConfig.tag to the version, and leaves latest where it was', () => {
      expect(tagsAfterLatest).toEqual({ latest: '0.0.1' });
      expect(tagsAfterStaging).toEqual({ latest: '0.0.1', staging: '0.0.2' });
      expect(foundA).toBe('0.0.1');
      expect(foundB).toBe('0.0.2');
    });
  });

  describe('staging-only dist-tag', () => {
    let tagsFirst: Record<string, string> | undefined;
    let foundFirstA: string | undefined;
    let tagsSecond: Record<string, string> | undefined;
    let foundSecondB: string | undefined;
    let foundSecondA: string | undefined;
    let foundMissing: string | undefined;
    let tagsFinal: Record<string, string> | undefined;

    beforeAll(async () => {
      packages.delete(NAME);

      await npmRegistry.publish(folder('0.0.1', 'a'.repeat(64), 'staging'), app);

      tagsFirst = { ...packages.get(NAME)?.tags };

      foundFirstA = await npmRegistry.find(NAME, 'a'.repeat(64), app, registryUrl);

      await npmRegistry.publish(folder('0.0.2', 'b'.repeat(64), 'staging'), app);

      tagsSecond = { ...packages.get(NAME)?.tags };

      foundSecondB = await npmRegistry.find(NAME, 'b'.repeat(64), app, registryUrl);

      foundSecondA = await npmRegistry.find(NAME, 'a'.repeat(64), app, registryUrl);

      foundMissing = await npmRegistry.find(NAME, 'c'.repeat(64), app, registryUrl);

      await npmRegistry.tag(NAME, '0.0.2', 'production', app, registryUrl);

      await npmRegistry.tag(NAME, '0.0.2', 'latest', app, registryUrl);

      tagsFinal = { ...packages.get(NAME)?.tags };
    });

    it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: find locates a version when the package has only the staging dist-tag and no latest tag', () => {
      expect(tagsFirst).toEqual({ staging: '0.0.1' });
      expect(foundFirstA).toBe('0.0.1');
      expect(tagsSecond).toEqual({ staging: '0.0.2' });
      expect(foundSecondB).toBe('0.0.2');
      expect(foundSecondA).toBe('0.0.1');
      expect(foundMissing).toBeUndefined();
      expect(tagsFinal).toEqual({ staging: '0.0.2', production: '0.0.2', latest: '0.0.2' });
    });
  });

  it('find and tag pass --registry explicitly without relying on a scoped .npmrc mapping', async () => {
    packages.delete(NAME);

    const { port } = server.address() as AddressInfo;

    const noScopeMapApp = tempFolder({
      'package.json': '{"name":"app","private":true}',
      '.npmrc': `//localhost:${port}/:_authToken=test\n`,
    });

    await npmRegistry.publish(folder('0.0.3', 'd'.repeat(64), 'staging'), app);

    expect(await npmRegistry.find(NAME, 'd'.repeat(64), noScopeMapApp, registryUrl)).toBe('0.0.3');

    await npmRegistry.tag(NAME, '0.0.3', 'production', noScopeMapApp, registryUrl);

    expect(packages.get(NAME)?.tags['production']).toBe('0.0.3');
  });

  it('find treats empty npm view output as no versions instead of failing on JSON parse', async () => {
    packages.set(NAME, { versions: {}, tarballs: {}, tags: {} });

    expect(await npmRegistry.find(NAME, 'a'.repeat(64), app, registryUrl)).toBeUndefined();

    packages.set(NAME, { versions: { '0.0.1': { name: NAME } }, tarballs: {}, tags: {} });

    expect(await npmRegistry.find(NAME, 'a'.repeat(64), app, registryUrl)).toBeUndefined();
  });
});
