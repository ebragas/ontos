import type { User } from '@osdk/foundry.admin';
import { z } from 'zod';

export const WorkosUser = z.object({
  id: z.string(),
  email: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
});

export type WorkosUser = z.infer<typeof WorkosUser>;

export const PERSON_ID = /^user_[0-9A-Za-z]{1,64}$/;

export const WORKOS_MAX_PAGE = 100;

export const MAX_LIST_PAGES = 20;

export function toUser(user: WorkosUser, status: User['status']): User {
  return {
    id: user.id,
    username: user.email,
    email: user.email,
    ...(user.first_name ? { givenName: user.first_name } : {}),
    ...(user.last_name ? { familyName: user.last_name } : {}),
    realm: 'workos',
    status,
    attributes: {},
  };
}
