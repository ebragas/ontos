import { stored, twinFunctions, twinGrants, twinIr, type TwinVersion } from '../../src/ontology/stored.test-utils.ts';

export interface TwinPublishOptions {
  readonly baseUrl: string;
  readonly publishToken: () => Promise<string>;
}

const PUBLISH_PATH = '/api/ontology-service/v1/publish';

export async function publishTwin(options: TwinPublishOptions, version: TwinVersion): Promise<void> {
  const body = {
    ir: twinIr(version),
    functions: twinFunctions(version),
    product: 'twin',
    schemaMigrations: { migrations: [] },
    osdkSet: stored(twinIr(version)).osdkSet,
    grants: twinGrants(version),
    validateOnly: false,
  };

  const response = await fetch(new URL(PUBLISH_PATH, options.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${await options.publishToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (response.status !== 200)
    throw new Error(`The publish of the twin IR ${version} gave ${response.status}: ${await response.text()}`);
}
