import { kebabCase, linkTypeRid, ridNamespace } from '@ericbragas/ontos-service/convert';
import { settle } from '../fallible.ts';

export function findLinkType<Side extends { readonly linkTypeRid: string }>(
  productRid: string,
  apiName: string,
  sides: readonly Side[],
): { apiName: string; rid: string; sides: Side[] } | undefined {
  const namespace = settle(ridNamespace(productRid));

  if (!namespace.ok) return undefined;

  const rid = linkTypeRid(namespace.value, kebabCase(apiName));
  const found = sides.filter((side) => side.linkTypeRid === rid);

  return found.length > 0 ? { apiName, rid, sides: found } : undefined;
}
