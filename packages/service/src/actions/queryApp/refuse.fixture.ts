import { UserFacingError } from '@osdk/functions';

export default async function refuse(): Promise<string> {
  throw Object.assign(new UserFacingError('The text is refused.'), { parameterId: 'text' });
}
