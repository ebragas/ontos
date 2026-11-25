import { http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { WORKOS_API } from './users.ts';

export type WorkosAnswer = (request: Request) => Response | Promise<Response>;

export function workosServer(): (answer: WorkosAnswer) => void {
  const server = setupServer();

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

  afterEach(() => server.resetHandlers());

  afterAll(() => server.close());

  return (answer) => server.use(http.all(`${WORKOS_API}/*`, ({ request }) => answer(request)));
}
