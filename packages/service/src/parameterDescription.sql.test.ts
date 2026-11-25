import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NS, twinFunctions, twinIr } from './ontology/stored.test-utils.ts';
import { startMetadata, type MetadataService } from './metadata.test-utils.ts';

const REASON = 'Why the account closes.';
const CLOSE_ACCOUNT = `${NS}close-account-action`;

let service: MetadataService;

beforeAll(async () => {
  const functions = twinFunctions('0.4.0');

  const discovered = functions.discovered.map((fn) =>
    fn.locator.typescript?.functionName === 'closeAccount'
      ? {
          ...fn,
          inputs: fn.inputs.map((input) => (input.name === 'reason' ? { ...input, description: REASON } : input)),
        }
      : fn,
  );

  service = await startMetadata(twinIr('0.4.0'), { ...functions, discovered });
});

afterAll(async () => {
  await service.stop();
});

describe('the description of a function-backed Action parameter', () => {
  it('ontology/action-types/action-types#parameters/8d707699: GET actionTypes/{actionType} of a function-backed Action gives the parameter description', async () => {
    const answer = await service.get(`actionTypes/${CLOSE_ACCOUNT}`);

    expect(answer.status).toBe(200);

    const { parameters } = answer.body as { parameters: Record<string, object> };

    expect(parameters['reason']).toMatchObject({ description: REASON });
    expect(parameters['account']).not.toHaveProperty('description');
  });

  it('ontology/action-types/action-types#parameters/8d707699: fullMetadata gives the same parameter description', async () => {
    const answer = await service.get('fullMetadata');

    expect(answer.body).toMatchObject({
      actionTypes: { [CLOSE_ACCOUNT]: { parameters: { reason: { description: REASON } } } },
    });
  });
});
