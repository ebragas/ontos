import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTo } from '../packages/cli/build.ts';
import { outcome } from '../packages/service/src/errors/fallible.ts';
import { makeServicePackage } from '../tools/packaging/service-package.ts';
import {
  SHARED_BUILD_PORT_ENV,
  type SharedBuildKind,
  type SharedBuilds,
  type SharedCliBuild,
  type SharedCliPack,
  type SharedServicePackage,
} from './sharedBuildClient.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_BUNDLE = join(ROOT, 'packages/cli/dist/ontos.js');

function runCommand(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error)
        reject(new Error(`${command} ${args.join(' ')} exited with ${String(error.code)}: ${stderr || stdout}`));
      else resolve(stdout);
    });
  });
}

async function packTarball(
  args: readonly string[],
  destination: string,
): Promise<{ readonly file: string; readonly files: readonly string[] }> {
  const output = await runCommand('npm', ['pack', ...args, '--pack-destination', destination, '--json'], ROOT);

  const [packed] = JSON.parse(output) as { filename: string; files: { path: string }[] }[];

  if (!packed) throw new Error('npm pack wrote no file.');

  return { file: join(destination, packed.filename), files: packed.files.map(({ path }) => path).sort() };
}

export default async function setup(): Promise<() => Promise<void>> {
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'ontology-shared-build-')));
  const cache = new Map<SharedBuildKind, Promise<SharedBuilds[SharedBuildKind]>>();

  const get = <K extends SharedBuildKind>(kind: K): Promise<SharedBuilds[K]> => {
    const existing = cache.get(kind);

    if (existing !== undefined) return existing as Promise<SharedBuilds[K]>;

    const created: Promise<SharedBuilds[SharedBuildKind]> =
      kind === 'cliBuild' ? buildCli() : kind === 'cliPack' ? packCli() : buildAndPackService();

    cache.set(kind, created);

    return created as Promise<SharedBuilds[K]>;
  };

  async function buildCli(): Promise<SharedCliBuild> {
    await buildTo(CLI_BUNDLE);

    return { bundle: CLI_BUNDLE };
  }

  async function packCli(): Promise<SharedCliPack> {
    const { bundle } = await get('cliBuild');

    const destination = mkdtempSync(join(workDir, 'cli-pack-'));

    const { file, files } = await packTarball(['-w', 'packages/cli'], destination);

    return { file, files, bundle };
  }

  async function buildAndPackService(): Promise<SharedServicePackage> {
    const parent = mkdtempSync(join(workDir, 'service-pack-'));
    const folder = join(parent, 'service');

    const made = await outcome(() => makeServicePackage(folder));

    if (!made.ok) throw made.error;

    const { file, files } = await packTarball([folder, '--ignore-scripts'], parent);

    return { folder, file, files };
  }

  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);

    socket.on('close', () => sockets.delete(socket));

    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      const newline = buffer.indexOf('\n');

      if (newline === -1) return;

      const raw = buffer.slice(0, newline);

      buffer = buffer.slice(newline + 1);

      let kind: SharedBuildKind;

      try {
        const parsed = JSON.parse(raw) as { kind?: unknown };

        if (parsed.kind !== 'cliBuild' && parsed.kind !== 'cliPack' && parsed.kind !== 'servicePackage') {
          socket.end(`${JSON.stringify({ ok: false, error: `Unknown shared build kind: ${String(parsed.kind)}` })}\n`);

          return;
        }

        kind = parsed.kind;
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);

        return;
      }

      void get(kind).then(
        (value) => socket.end(`${JSON.stringify({ ok: true, value })}\n`),
        (error: unknown) =>
          socket.end(
            `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
          ),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);

    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as net.AddressInfo;

  process.env[SHARED_BUILD_PORT_ENV] = String(address.port);

  return async () => {
    delete process.env.ONTOLOGY_SHARED_BUILD_PORT;

    for (const socket of sockets) socket.destroy();

    await new Promise<void>((resolve) => server.close(() => resolve()));

    rmSync(workDir, { recursive: true, force: true });
  };
}
