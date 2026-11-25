import type { JWTPayload } from 'jose';
import { z } from 'zod';
import type { AsyncFallible } from '../errors/index.ts';
import { OrganizationId, UserId, type ServiceCaller } from './caller.ts';
import { keptAnswers, withinLimit, type Failure, type OnBackground } from './kept.ts';
import { workosReader } from './workosCalls.ts';

export const CLIENT_ID = /^client_[0-9A-Z]{26}$/;

export interface Application {
  readonly clientId: string;
  readonly type: string;
  readonly organization: string;
  readonly scopes: readonly string[];
}

export type ApplicationSource = (
  clientId: string,
  signal?: AbortSignal,
) => AsyncFallible<Application | undefined, Failure>;

interface ServiceClaims {
  readonly clientId: UserId;
  readonly organization: OrganizationId;
}

const ServiceTokenClaims = z.object({
  sub: z.string(),
  client_id: z.string().regex(CLIENT_ID).pipe(UserId),
  org_id: OrganizationId,
});

export function serviceClaims(payload: JWTPayload): ServiceClaims | undefined {
  const claims = ServiceTokenClaims.safeParse(payload);

  if (!claims.success || claims.data.client_id !== claims.data.sub || 'sid' in payload || 'sub_profile' in payload)
    return undefined;

  return { clientId: claims.data.client_id, organization: claims.data.org_id };
}

export async function* serviceCaller(
  claims: ServiceClaims,
  applications: ApplicationSource,
  signal?: AbortSignal,
): AsyncFallible<ServiceCaller | undefined, Failure> {
  const application = yield* applications(claims.clientId, signal);

  if (
    !application ||
    application.clientId !== claims.clientId ||
    application.type !== 'm2m' ||
    application.organization !== claims.organization
  )
    return undefined;

  return {
    user: claims.clientId,
    kind: 'service',
    organization: claims.organization,
    permissions: [...new Set(application.scopes.filter((scope) => scope !== '*'))].sort(),
  };
}

const WorkosApplication = z.object({
  client_id: z.string(),
  application_type: z.string(),
  organization_id: z.string(),
  scopes: z.array(z.string()),
});

export function workosApplications(
  apiKey: string,
  apiUrl: string,
  fetch: typeof globalThis.fetch,
  onBackground?: OnBackground,
): ApplicationSource {
  const applications = keptAnswers<Application | undefined>({ onBackground });
  const read = workosReader(apiKey, apiUrl, fetch);

  const application = (clientId: string) =>
    async function* (signal: AbortSignal): AsyncFallible<Application | undefined, Failure> {
      const found = yield* read(
        'application',
        `/connect/applications/${encodeURIComponent(clientId)}`,
        WorkosApplication,
        signal,
      );

      return (
        found && {
          clientId: found.client_id,
          type: found.application_type,
          organization: found.organization_id,
          scopes: found.scopes,
        }
      );
    };

  return (clientId, signal) => withinLimit((limit) => applications.get(clientId, application(clientId), limit), signal);
}
