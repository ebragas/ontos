import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterAll } from 'vitest';

export interface Finding {
  readonly rule: string;
  readonly message: string;
}

interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly range: { readonly start: { readonly line: number; readonly character: number } };
}

interface Published {
  readonly uri: string;
  readonly version?: number;
  readonly diagnostics: readonly Diagnostic[];
}

const root = new URL('../../../', import.meta.url);

export function lintProbe(): (file: string, code: string) => Promise<Finding[]> {
  const server = spawn(new URL('node_modules/.bin/oxlint', root).pathname, ['--lsp'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const waiting = new Map<string, { version: number; done: (published: Published) => void }>();
  let ready: () => void = () => undefined;
  const initialized = new Promise<void>((resolve) => (ready = resolve));
  let exited: Error | undefined;

  server.on('exit', (code) => {
    exited = new Error(`oxlint --lsp exited with code ${code}`);
  });

  let buffer = Buffer.alloc(0);

  server.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    for (let end = buffer.indexOf('\r\n\r\n'); end >= 0; end = buffer.indexOf('\r\n\r\n')) {
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);

      if (buffer.length < end + 4 + length) return;

      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()) as {
        id?: number;
        method?: string;
        params?: Published;
      };

      buffer = buffer.subarray(end + 4 + length);

      if (message.id === 1 && message.method === undefined) ready();

      const published = message.method === 'textDocument/publishDiagnostics' ? message.params : undefined;
      const waiter = published ? waiting.get(published.uri) : undefined;

      if (published && waiter && waiter.version === published.version) waiter.done(published);
    }
  });

  let id = 0;

  const send = (method: string, params: object, request = false): void => {
    const text = JSON.stringify({ jsonrpc: '2.0', ...(request ? { id: ++id } : {}), method, params });

    server.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  };

  const rootUri = root.href.replace(/\/$/, '');

  send(
    'initialize',
    { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'root' }], capabilities: {} },
    true,
  );

  afterAll(() => {
    server.kill();
  });

  let version = 0;
  let queue: Promise<unknown> = initialized.then(() => send('initialized', {}));

  const lintOne = async (file: string, code: string): Promise<Finding[]> => {
    if (exited) throw exited;

    const uri = pathToFileURL(new URL(file, root).pathname).href;
    const current = ++version;

    const published = await new Promise<Published>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(exited ?? new Error(`oxlint --lsp gave no diagnostics for ${file}`)),
        10_000,
      );

      waiting.set(uri, { version: current, done: (result) => (clearTimeout(timer), resolve(result)) });

      send('textDocument/didOpen', { textDocument: { uri, languageId: 'typescript', version: current, text: code } });
    });

    waiting.delete(uri);

    send('textDocument/didClose', { textDocument: { uri } });

    const crash = published.diagnostics.find((d) => d.message.startsWith('Error running JS plugin'));

    if (crash) throw new Error(`oxlint could not lint the probe at ${file}: ${crash.message}`);

    return [...published.diagnostics]
      .sort(
        (a, b) =>
          a.range.start.line - b.range.start.line ||
          a.range.start.character - b.range.start.character ||
          a.code.localeCompare(b.code),
      )
      .map((d) => ({
        rule: d.code.replace(/^eslint\((.+)\)$/, '$1').replace(/^([\w-]+)\((.+)\)$/, '$1/$2'),
        message: d.message.replace('\nhelp: ', ' '),
      }));
  };

  return (file, code) => {
    const result = queue.then(() => lintOne(file, code));

    queue = result.catch(() => undefined);

    return result;
  };
}
