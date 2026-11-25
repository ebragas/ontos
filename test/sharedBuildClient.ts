import net from 'node:net';

export const SHARED_BUILD_PORT_ENV = 'ONTOLOGY_SHARED_BUILD_PORT';

export interface SharedCliBuild {
  readonly bundle: string;
}

export interface SharedCliPack {
  readonly file: string;
  readonly files: readonly string[];
  readonly bundle: string;
}

export interface SharedServicePackage {
  readonly folder: string;
  readonly file: string;
  readonly files: readonly string[];
}

export interface SharedBuilds {
  readonly cliBuild: SharedCliBuild;
  readonly cliPack: SharedCliPack;
  readonly servicePackage: SharedServicePackage;
}

export type SharedBuildKind = keyof SharedBuilds;

type BuildResponse<K extends SharedBuildKind> =
  { readonly ok: true; readonly value: SharedBuilds[K] } | { readonly ok: false; readonly error: string };

export function requestSharedBuild<K extends SharedBuildKind>(kind: K): Promise<SharedBuilds[K] | undefined> {
  const raw = process.env[SHARED_BUILD_PORT_ENV];

  if (raw === undefined || raw === '') return Promise.resolve(undefined);

  const port = Number(raw);

  if (!Number.isInteger(port) || port <= 0) return Promise.resolve(undefined);

  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = '';
    let settled = false;

    const done = (fn: () => void) => {
      if (settled) return;

      settled = true;

      socket.destroy();

      fn();
    };

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ kind })}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      const newline = buffer.indexOf('\n');

      if (newline === -1) return;

      const line = buffer.slice(0, newline);

      try {
        const reply = JSON.parse(line) as BuildResponse<K>;

        if (reply.ok) done(() => resolve(reply.value));
        else done(() => reject(new Error(reply.error)));
      } catch (error) {
        done(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });

    socket.on('error', (error) => done(() => reject(error)));

    socket.on('end', () =>
      done(() => reject(new Error(`The shared build coordinator closed without answering ${kind}.`))),
    );
  });
}
