import { invariant } from '../../errors/index.ts';
import type { WorkosPort } from '../../publish/index.ts';
import { authenticate, authenticateMcp } from '../authenticate.ts';
import type { AuthSettings } from '../caller.ts';
import type { KeySource } from '../keys.ts';
import { tokenRoute } from '../token.ts';
import type { UserSource } from '../users.ts';
import type { IdentityProvider } from './types.ts';

export interface WorkosIdentityOptions {
  readonly settings: AuthSettings;
  readonly authkitDomain?: string | undefined;
  readonly keys: KeySource;
  readonly users: UserSource;
  readonly workos: WorkosPort;
}

export function workosIdentityProvider(options: WorkosIdentityOptions): IdentityProvider {
  const { settings, authkitDomain, keys, users, workos } = options;

  return {
    mode: 'workos',
    users,
    workos,
    authenticate: (request, { known }) =>
      authenticate(request, settings, keys, { authkitDomain, applications: users.applications }, known),
    authenticateMcp: (request) => {
      invariant(authkitDomain !== undefined, 'AUTHKIT_DOMAIN is not set.');

      return authenticateMcp(request, { authkitDomain, baseUrl: settings.baseUrl }, keys.authkit);
    },
    tokenRoute,
  };
}
