import type { WorkosUser } from '../src/auth/index.ts';
import { ORGANIZATION } from './tokens.ts';
import type { StubApplication } from './workosTypes.ts';

export const STUB_WORKOS_KEY = 'sk_test_stub';

/** The person of the stub: a WorkOS user with a first and a last name. */
export const STUB_PERSON: WorkosUser = {
  id: 'user_01TEST00000000000000000001',
  email: 'ada@example.com',
  first_name: 'Ada',
  last_name: 'Lovelace',
};

/** The application of `SERVICE_USER`: an M2M application of `ORGANIZATION` with no scope. */
export const STUB_APPLICATION: StubApplication = {
  name: 'Nightly sync',
  application_type: 'm2m',
  organization_id: ORGANIZATION,
  scopes: [],
};
