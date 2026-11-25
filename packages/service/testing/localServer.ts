import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * On macOS, a bind to `::` can share its port with a `[::1]` listener of another process, such as a Docker Desktop
 * port forward, and a request to `localhost` then reaches that process.
 */
export function listenLocal(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());

    server.closeAllConnections();
  });
}
