import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NS, twinFunctions, twinIr } from './ontology/stored.test-utils.ts';
import { asJson, convertTwin, startMetadata, type MetadataService } from './metadata.test-utils.ts';

let service: MetadataService;

beforeAll(async () => {
  service = await startMetadata(twinIr('0.4.0'), twinFunctions('0.4.0'));
});

afterAll(async () => {
  await service.stop();
});

describe('GET actionTypes/{actionType}', () => {
  it('ontology/action-types/action-types#parts: the route serves the Action Type of the stored metadata', async () => {
    const { metadata } = convertTwin('0.4.0');

    for (const name of ['create-engagement', 'close-account-action'] as const) {
      const answer = await service.get(`actionTypes/${NS}${name}`);

      expect(answer).toEqual({ status: 200, body: asJson(metadata.actionTypes[`${NS}${name}`]) });
    }
  });

  it('service/http-api#errors: an unknown Action Type gets 404 ActionTypeNotFound with actionType', async () => {
    const answer = await service.get('actionTypes/nope');

    expect(answer.status).toBe(404);

    expect(answer.body).toEqual({
      errorCode: 'NOT_FOUND',
      errorName: 'ActionTypeNotFound',
      errorInstanceId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      parameters: { actionType: 'nope' },
    });
  });

  it('service/http-api#errors: a camelCase Action Type name gets 404 ActionTypeNotFound that also names the published name', async () => {
    for (const [name, parameters] of [
      [
        `${NS}closeAccountAction`,
        { actionType: `${NS}closeAccountAction`, publishedApiName: `${NS}close-account-action` },
      ],
      ['closeAccountAction', { actionType: 'closeAccountAction', publishedApiName: `${NS}close-account-action` }],
      ['nopeAction', { actionType: 'nopeAction' }],
    ] as const) {
      const answer = await service.get(`actionTypes/${name}`);

      expect(answer).toMatchObject({ status: 404, body: { errorName: 'ActionTypeNotFound' } });
      expect((answer.body as { parameters: unknown }).parameters).toEqual(parameters);
    }
  });
});
