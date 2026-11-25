import type { ApiError, AsyncFallible } from '../../errors/index.ts';
import type { Settings } from '../../handler/index.ts';
import type { WorkosPort } from '../../publish/index.ts';
import type { KnownCaller } from '../authenticate.ts';
import type { Caller, PersonCaller } from '../caller.ts';
import type { UserSource } from '../users.ts';
import type { Failure } from '../workosErrors.ts';

export type AuthMode = 'dev' | 'oidc' | 'workos';

export type AuthRouteAccess = 'data' | 'publish';

export interface AuthenticateOptions {
  readonly access: AuthRouteAccess;
  readonly known?: (caller: KnownCaller) => void;
}

export interface CallerProfile {
  readonly username: string;
  readonly email?: string;
  readonly givenName?: string;
  readonly familyName?: string;
  readonly realm: string;
}

export interface McpCaller extends PersonCaller {
  readonly clientId?: string;
}

export interface IdentityProvider {
  readonly mode: AuthMode;
  readonly users: UserSource;
  readonly workos: WorkosPort;
  readonly authenticate: (request: Request, options: AuthenticateOptions) => AsyncFallible<Caller, Failure>;
  readonly authenticateMcp: (request: Request) => AsyncFallible<McpCaller, Failure>;
  readonly tokenRoute: (request: Request, settings: Settings) => AsyncFallible<Response, ApiError>;
}
