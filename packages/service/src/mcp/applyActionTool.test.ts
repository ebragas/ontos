import { describe, expect, it } from 'vitest';
import { settle } from '../errors/index.ts';
import type { McpCtx, RouteCall } from '../handler/index.ts';
import { TOOLS } from './tools.ts';

describe('service/ontology-mcp#tools: apply_action always sends returnEdits ALL_V2_WITH_DELETIONS', () => {
  it('service/ontology-mcp#tools: the apply route gets the parameters, mode VALIDATE_AND_EXECUTE, and returnEdits ALL_V2_WITH_DELETIONS', async () => {
    const calls: RouteCall[] = [];

    const runRoute = (routeCall: RouteCall) => {
      calls.push(routeCall);

      return Promise.resolve({ status: 200, body: {} });
    };

    const applyAction = TOOLS.find((tool) => tool.name === 'apply_action');
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The tool reads only runRoute of the McpCtx.
    const ctx = { runRoute } as Partial<McpCtx> as McpCtx;

    if (applyAction)
      await settle(
        applyAction.call({ action: 'com.example.twin.set-engagement-status', parameters: { status: 'won' } }, ctx),
      );

    expect(calls).toEqual([
      {
        key: 'POST /api/v2/ontologies/{ontology}/actions/{action}/apply',
        params: { action: 'com.example.twin.set-engagement-status' },
        body: {
          parameters: { status: 'won' },
          options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
        },
      },
    ]);
  });
});
