import { z } from 'zod';

declare const userIdBrand: unique symbol;
declare const organizationIdBrand: unique symbol;

export type UserId = string & { readonly [userIdBrand]: true };

export const UserId = z.string().refine((id): id is UserId => id !== '');

export type OrganizationId = string & { readonly [organizationIdBrand]: true };

export const OrganizationId = z.string().refine((id): id is OrganizationId => id !== '');

export interface GithubTrust {
  readonly repository: string;
  readonly environment: string;
}

export interface AuthSettings {
  readonly workosClientId: string;
  readonly baseUrl: string;
  readonly app: GithubTrust;
}
