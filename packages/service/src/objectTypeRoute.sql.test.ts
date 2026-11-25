import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NS, twinFunctions, twinIr } from './ontology/stored.test-utils.ts';
import { asJson, convertTwin, startMetadata, type MetadataService } from './metadata.test-utils.ts';

const ACCOUNT = `${NS}Account`;

let service: MetadataService;

beforeAll(async () => {
  service = await startMetadata(twinIr('0.7.0'), twinFunctions('0.7.0'));
});

afterAll(async () => {
  await service.stop();
});

describe('GET objectTypes/{objectType}/fullMetadata', () => {
  it('service/http-api#requests: the route ignores preview, and serves the Object Type of the stored metadata', async () => {
    const expected = asJson(convertTwin('0.7.0').metadata.objectTypes[ACCOUNT]);

    for (const query of ['', '?preview=true', '?preview=false']) {
      const answer = await service.get(`objectTypes/${ACCOUNT}/fullMetadata${query}`);

      expect(answer).toEqual({ status: 200, body: expected });
    }
  });

  it('service/http-api#errors: an unknown Object Type gets 404 ObjectTypeNotFound with objectType', async () => {
    const answer = await service.get('objectTypes/Nope/fullMetadata');

    expect(answer.status).toBe(404);

    expect(answer.body).toEqual({
      errorCode: 'NOT_FOUND',
      errorName: 'ObjectTypeNotFound',
      errorInstanceId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      parameters: { objectType: 'Nope' },
    });
  });
});
