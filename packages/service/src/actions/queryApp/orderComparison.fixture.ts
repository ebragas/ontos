import type { Client } from '@osdk/client';

export interface OrderComparison {
  readonly cheaper: string;
  readonly first: string;
  readonly second: string;
  readonly same: boolean;
}

export default async function orderComparison(
  _client: Client,
  first: string,
  second: string,
): Promise<OrderComparison> {
  return { cheaper: Number(first) <= Number(second) ? 'first' : 'second', first, second, same: first === second };
}
