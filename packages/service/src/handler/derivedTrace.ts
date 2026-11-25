import type { DerivedUse } from '../objectSets/index.ts';
import { apiNameOf, span, type LiveSpan, type StartAttributes } from '../spans/index.ts';
import type { Ctx } from './context.ts';

const recordDerived =
  (root: LiveSpan<'root'> | undefined): Ctx['traceDerived'] =>
  ({ values, objects, sqlMs }) => {
    if (values.length === 0) return;

    for (const value of values) span('derived property', attributesOf(value), () => undefined);

    root?.set('derived.count', values.length);

    if (objects !== undefined) root?.set('derived.objects', objects);

    root?.set('derived.sql_ms', sqlMs);
  };

const unrootedTrace = recordDerived(undefined);

export function derivedTrace(root: LiveSpan<'root'> | undefined): Ctx['traceDerived'] {
  return root === undefined ? unrootedTrace : recordDerived(root);
}

function attributesOf({
  objectType,
  origin,
  reason,
  hops,
  operation,
}: DerivedUse): StartAttributes<'derived property'> {
  const name =
    origin.form === 'objectType'
      ? { 'derived.api_name': apiNameOf(origin.property) }
      : { 'derived.position': origin.position };

  return {
    'object_type.api_name': apiNameOf(objectType),
    'derived.form': origin.form,
    'derived.reason': reason,
    'derived.hops': hops,
    'derived.operation': operation,
    ...name,
  };
}
