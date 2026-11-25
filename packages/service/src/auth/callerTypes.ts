import type { OrganizationId, UserId } from './callerIds.ts';
import type { CallerProfile } from './providers/types.ts';

export type CallerKind = 'person' | 'publish' | 'check' | 'service';

export interface PersonCaller {
  readonly user: UserId;
  readonly kind: 'person';
  readonly organization?: OrganizationId;
  readonly permissions?: readonly string[];
  readonly profile?: CallerProfile;
}

export interface GithubCaller {
  readonly user: UserId;
  readonly kind: Exclude<CallerKind, 'person' | 'service'>;
}

export interface ServiceCaller {
  readonly user: UserId;
  readonly kind: 'service';
  readonly organization: OrganizationId;
  readonly permissions: readonly string[];
}

export type DataCaller = PersonCaller | ServiceCaller;

export type Caller = PersonCaller | GithubCaller | ServiceCaller;
