import { jsonValueOf } from '../db/index.ts';
import type { JsonValue, OutputValueType, QueryOutput } from '../ontology/index.ts';

type OutputCheck = { readonly ok: true; readonly value: JsonValue } | { readonly ok: false; readonly path: string };

export function checkOutput(returned: unknown, output: QueryOutput): OutputCheck {
  if (returned === null && output.optional) return { ok: true, value: null };

  return valueOf(returned, output.type, 'value');
}

function valueOf(value: unknown, type: OutputValueType, path: string): OutputCheck {
  switch (type.kind) {
    case 'object':
      return isRecord(value) && value['$apiName'] === type.objectType && typeof value['$primaryKey'] === 'string'
        ? { ok: true, value: value['$primaryKey'] }
        : { ok: false, path };
    case 'list':
      return Array.isArray(value) ? listOf(value, type.element, path) : { ok: false, path };
    case 'struct':
      return isRecord(value) ? structOf(value, type.fields, path) : { ok: false, path };
    default: {
      const json = jsonValueOf(value, type);

      return json === undefined ? { ok: false, path } : { ok: true, value: json };
    }
  }
}

function listOf(list: readonly unknown[], element: OutputValueType, path: string): OutputCheck {
  const checked: JsonValue[] = [];

  for (const [index, value] of list.entries()) {
    const each = valueOf(value, element, `${path}[${index}]`);

    if (!each.ok) return each;

    checked.push(each.value);
  }

  return { ok: true, value: checked };
}

function structOf(
  value: Readonly<Record<string, unknown>>,
  fields: Extract<OutputValueType, { kind: 'struct' }>['fields'],
  path: string,
): OutputCheck {
  const checked: Record<string, JsonValue> = {};

  for (const [name, field] of fields) {
    const fieldValue = Object.hasOwn(value, name) ? value[name] : undefined;

    if ((fieldValue === undefined || fieldValue === null) && field.optional) continue;

    const each = valueOf(fieldValue, field.type, `${path}.${name}`);

    if (!each.ok) return each;

    checked[name] = each.value;
  }

  return { ok: true, value: checked };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
