import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NS, twinFunctions, twinIr } from './ontology/stored.test-utils.ts';
import { asJson, convertTwin, startMetadata, UUID, type MetadataService } from './metadata.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ERROR_INSTANCE_ID = expect.stringMatching(new RegExp(`^${UUID}$`));

let service: MetadataService;
const { metadata } = convertTwin('0.4.0');

const objectTypes = Object.keys(metadata.objectTypes)
  .sort()
  .map((name) => asJson(metadata.objectTypes[name]?.objectType));

const actionTypes = Object.keys(metadata.actionTypes)
  .sort()
  .map((name) => asJson(metadata.actionTypes[name]));

beforeAll(async () => {
  service = await startMetadata(twinIr('0.4.0'), twinFunctions('0.4.0'));
});

afterAll(async () => {
  await service.stop();
});

async function walk(path: string, pageSize: number): Promise<{ pages: number; data: unknown[] }> {
  const data: unknown[] = [];
  let token: string | undefined;
  let pages = 0;

  do {
    const query = `?pageSize=${pageSize}${token === undefined ? '' : `&pageToken=${token}`}`;

    const answer = await service.get(`${path}${query}`);

    expect(answer.status).toBe(200);

    const body = answer.body as { data: unknown[]; nextPageToken?: string };

    data.push(...body.data);

    token = body.nextPageToken;

    pages += 1;
  } while (token !== undefined);

  return { pages, data };
}

describe('GET objectTypes and GET actionTypes', () => {
  it('service/http-api#metadata-routes: objectTypes lists the ObjectTypeV2 of each Object Type in the code point order of their API names', async () => {
    expect(objectTypes.length).toBeGreaterThan(1);

    expect(await service.get('objectTypes')).toEqual({ status: 200, body: { data: objectTypes } });
  });

  it('service/http-api#metadata-routes: actionTypes lists the ActionTypeV2 of each Action Type in the code point order of their API names', async () => {
    expect(actionTypes.length).toBeGreaterThan(1);

    expect(await service.get('actionTypes')).toEqual({ status: 200, body: { data: actionTypes } });
  });

  it('service/http-api#metadata-routes: each list takes pageSize and pageToken, and a pageSize over 500 gets pages of 500', async () => {
    expect(await walk('objectTypes', 1)).toEqual({ pages: objectTypes.length, data: objectTypes });

    expect(await walk('actionTypes', 2)).toEqual({ pages: Math.ceil(actionTypes.length / 2), data: actionTypes });

    expect(await service.get('actionTypes?pageSize=100000')).toEqual({ status: 200, body: { data: actionTypes } });
  });

  it('service/http-api#metadata-routes: a pageSize that is not an integer gets 400 Default:InvalidArgument, and 0 or less gets InvalidPageSize', async () => {
    for (const pageSize of ['abc', '1.5', '']) {
      expect(await service.get(`objectTypes?pageSize=${pageSize}`)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'Default:InvalidArgument',
          errorInstanceId: ERROR_INSTANCE_ID,
          parameters: {},
        },
      });
    }

    for (const pageSize of [0, -1]) {
      expect(await service.get(`actionTypes?pageSize=${pageSize}`)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'InvalidPageSize',
          errorInstanceId: ERROR_INSTANCE_ID,
          parameters: { pageSize },
        },
      });
    }
  });

  it('service/http-api#metadata-routes: a page token holds the API name of the last entry, and a token that the service cannot read gets 400 InvalidPageToken', async () => {
    const first = await service.get('objectTypes?pageSize=1');

    const token = (first.body as { nextPageToken: string }).nextPageToken;

    expect(JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))).toBe(
      (objectTypes[0] as { apiName: string }).apiName,
    );

    for (const bad of ['nope', Buffer.from('42', 'utf8').toString('base64url')]) {
      expect(await service.get(`actionTypes?pageToken=${bad}`)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'InvalidPageToken',
          errorInstanceId: ERROR_INSTANCE_ID,
          parameters: { pageToken: bad },
        },
      });
    }
  });
});

describe('GET objectTypes/{objectType} and GET actionTypes/byRid/{actionTypeRid}', () => {
  it('service/http-api#metadata-routes: objectTypes/{objectType} gives the ObjectTypeV2, and an unknown Object Type gets 404 ObjectTypeNotFound', async () => {
    expect(await service.get(`objectTypes/${ACCOUNT}`)).toEqual({
      status: 200,
      body: asJson(metadata.objectTypes[ACCOUNT]?.objectType),
    });

    expect(await service.get('objectTypes/Nope')).toEqual({
      status: 404,
      body: {
        errorCode: 'NOT_FOUND',
        errorName: 'ObjectTypeNotFound',
        errorInstanceId: ERROR_INSTANCE_ID,
        parameters: { objectType: 'Nope' },
      },
    });
  });

  it('service/http-api#metadata-routes: actionTypes/byRid gives the ActionTypeV2 of that RID, and an unknown RID gets 404 ActionTypeNotFound with rid', async () => {
    for (const actionType of Object.values(metadata.actionTypes)) {
      expect(await service.get(`actionTypes/byRid/${actionType.rid}`)).toEqual({
        status: 200,
        body: asJson(actionType),
      });
    }

    const rid = 'ri.actions.main.action-type.00000000-0000-0000-0000-000000000000';

    expect(await service.get(`actionTypes/byRid/${rid}`)).toEqual({
      status: 404,
      body: {
        errorCode: 'NOT_FOUND',
        errorName: 'ActionTypeNotFound',
        errorInstanceId: ERROR_INSTANCE_ID,
        parameters: { rid },
      },
    });
  });

  it('service/http-api#metadata-routes: the Object Type routes ignore includeDatasources, and each datasources list is empty', async () => {
    expect(await service.get('objectTypes?includeDatasources=true')).toEqual({
      status: 200,
      body: { data: objectTypes },
    });

    expect(await service.get(`objectTypes/${ACCOUNT}?includeDatasources=true`)).toEqual({
      status: 200,
      body: asJson(metadata.objectTypes[ACCOUNT]?.objectType),
    });

    expect(objectTypes.every((objectType) => (objectType as { datasources: unknown[] }).datasources.length === 0)).toBe(
      true,
    );
  });
});
