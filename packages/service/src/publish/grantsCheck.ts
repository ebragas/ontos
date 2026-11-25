import {
  permissionIndex,
  personAttributeProblems,
  SERVICE_PERMISSIONS,
  SERVICE_PREFIX,
  type ActionTypeApiName,
  type CompiledOntology,
  type Condition,
  type ConditionValue,
  type GrantsFile,
  type PermissionSlug,
  type Policy,
  type QueryFunction,
} from '../ontology/index.ts';

const MAX_SLUG = 48;
const PERMISSION_SLUG = /^(?!\.+$)[a-z0-9_:.*-]{1,48}$/;
const ROLE_SLUG = /^[a-z0-9_-]{1,48}$/;
const MAX_DESCRIPTION = 150;
const CUSTOM_ROLE_PREFIX = 'org-';

export interface GrantsCheck {
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

export function checkGrantsFile(
  ontology: CompiledOntology,
  grants: GrantsFile,
  request: { readonly functions: boolean; readonly validateOnly: boolean },
): GrantsCheck {
  const problems: string[] = [];
  const declared = (slug: PermissionSlug) => Object.hasOwn(grants.permissions, slug);

  for (const [slug, { description }] of Object.entries(grants.permissions)) {
    if (slug.startsWith(SERVICE_PREFIX))
      problems.push(
        `The product permission ${slug} has the prefix ${SERVICE_PREFIX}, which the Ontology service keeps for its own permissions.`,
      );

    if (slug === '*') problems.push('The permission slug * is reserved for local dev mode.');
    else if (slug.length > MAX_SLUG)
      problems.push(`The permission slug ${slug} has ${slug.length} characters. WorkOS takes at most ${MAX_SLUG}.`);
    else if (!PERMISSION_SLUG.test(slug))
      problems.push(
        `The permission slug ${JSON.stringify(slug)} has a form that WorkOS does not take: 1 to 48 characters of a to z, 0 to 9, -, _, :, ., and *, and not dots only.`,
      );

    if (description.length > MAX_DESCRIPTION)
      problems.push(
        `The description of the permission ${slug} has ${description.length} characters. WorkOS takes at most ${MAX_DESCRIPTION}.`,
      );
  }

  const checkNamed = (owner: string, slug: PermissionSlug, what: 'type' | 'rule') => {
    if (slug.startsWith(SERVICE_PREFIX))
      problems.push(
        `${owner} names the permission ${slug} of the Ontology service. A ${what} names only a permission of the product.`,
      );
    else if (!declared(slug))
      problems.push(`${owner} names the permission ${slug}, which the key permissions does not declare.`);
  };

  const queryFunctions = new Map(
    [...ontology.functions].flatMap(([name, fn]) => (fn.kind === 'query' ? [[name, fn] as const] : [])),
  );

  const checksQueryTypes = request.functions || !request.validateOnly || grants.queryTypes === undefined;

  const parts = [
    { key: 'objectTypes', map: grants.objectTypes, types: ontology.objectTypes, what: 'Object Type' },
    { key: 'actionTypes', map: grants.actionTypes, types: ontology.actionTypes, what: 'Action Type' },
    ...(checksQueryTypes
      ? [{ key: 'queryTypes', map: grants.queryTypes ?? {}, types: queryFunctions, what: 'Query Function' }]
      : []),
  ];

  for (const { key, map, types, what } of parts) {
    for (const name of types.keys())
      if (!Object.hasOwn(map, name)) problems.push(`The ${what} ${name} names no permission.`);

    for (const [name, slug] of Object.entries(map)) {
      if (!types.has(name))
        problems.push(
          key === 'queryTypes'
            ? strayQueryType(ontology, name)
            : `The key ${name} of ${key} names no ${what} of the IR.`,
        );
      else checkNamed(`The ${what} ${name}`, slug, 'type');
    }
  }

  if (!checksQueryTypes)
    for (const [name, slug] of Object.entries(grants.queryTypes ?? {}))
      checkNamed(`The Query Function ${name}`, slug, 'type');

  for (const fn of queryFunctions.values()) {
    const problem = descriptionProblem(fn);

    if (problem) problems.push(problem);
  }

  for (const [owner, slugs] of rulePermissions(ontology)) for (const slug of slugs) checkNamed(owner, slug, 'rule');

  problems.push(...personAttributeProblems(ontology, grants));

  const index = permissionIndex(ontology, grants);
  const skipped = new Set<ActionTypeApiName>();

  if (!request.functions)
    for (const action of ontology.actionTypes.values())
      if (action.logic.kind === 'function') skipped.add(action.apiName);

  const typeRules = [
    ...[...index.actionTypes]
      .filter(([name]) => !skipped.has(name))
      .map(([name, entry]) => ({ owner: `the Action Type ${name}`, ...entry })),
    ...[...index.queryTypes].map(([name, entry]) => ({ owner: `the Query Function ${name}`, ...entry })),
  ];

  for (const [role, held] of Object.entries(grants.defaultRoles)) {
    if (!ROLE_SLUG.test(role))
      problems.push(
        `The default role slug ${JSON.stringify(role)} has a form that WorkOS does not take: 1 to 48 characters of a to z, 0 to 9, -, and _.`,
      );

    if (role.startsWith(CUSTOM_ROLE_PREFIX))
      problems.push(
        `The default role ${role} has the prefix ${CUSTOM_ROLE_PREFIX}, which WorkOS keeps for the custom roles of each Organization.`,
      );

    for (const slug of held) {
      if (!declared(slug) && !SERVICE_PERMISSIONS.includes(slug))
        problems.push(
          `The default role ${role} names the permission ${slug}, which is not a permission of the product or of the Ontology service.`,
        );
    }

    const holds = new Set(held);

    for (const { owner, own, requires } of typeRules) {
      if (!holds.has(own)) continue;

      const missing = requires.filter((slug) => !holds.has(slug));

      if (missing.length > 0)
        problems.push(
          `The default role ${role} holds the permission ${own} of ${owner}, but not ${missing.join(', ')}, which its Object Types need.`,
        );
    }
  }

  const warnings: string[] = [];

  if (skipped.size > 0)
    warnings.push(
      `The grants check did not run the default role rule for these function-backed Action Types, because the request has no Functions: ${[...skipped].sort().join(', ')}.`,
    );

  if (!checksQueryTypes)
    warnings.push(
      'The grants check did not match the key queryTypes with the Query Functions, because the request has no Functions.',
    );

  return { problems, warnings };
}

function strayQueryType(ontology: CompiledOntology, name: string): string {
  return ontology.functions.has(name)
    ? `The key ${name} of queryTypes names an edit Function. An edit Function has the permission of its Action Type.`
    : `The key ${name} of queryTypes names no Function.`;
}

function descriptionProblem({ apiName: name, description }: QueryFunction): string | undefined {
  const rule = 'Its first line is the description of the query type.';

  if (description === undefined || description.trim() === '')
    return `The Query Function ${name} has no doc comment. ${rule}`;

  if ((description.split('\n')[0] ?? '').trim() === '')
    return `The doc comment of the Query Function ${name} has an empty first line. ${rule}`;

  return undefined;
}

function rulePermissions(ontology: CompiledOntology): Map<string, Set<PermissionSlug>> {
  const named = new Map<string, Set<PermissionSlug>>();

  const add = (owner: string, slugs: readonly PermissionSlug[]) => {
    for (const slug of slugs) named.set(owner, (named.get(owner) ?? new Set()).add(slug));
  };

  for (const objectType of ontology.objectTypes.values()) {
    if (objectType.policy)
      add(`The object security policy of the Object Type ${objectType.apiName}`, policySlugs(objectType.policy));

    for (const property of objectType.properties.values()) {
      if (property.policy)
        add(
          `The property security policy of the Property ${property.apiName} of ${objectType.apiName}`,
          policySlugs(property.policy),
        );
    }
  }

  for (const action of ontology.actionTypes.values()) {
    add(
      `A Submission criterion of the Action Type ${action.apiName}`,
      action.criteria.flatMap(({ condition }) => conditionSlugs(condition)),
    );
  }

  return named;
}

function policySlugs(policy: Policy): PermissionSlug[] {
  if (policy.kind !== 'compare') return policy.conditions.flatMap(policySlugs);

  return policy.person.kind === 'permissions' && policy.object.kind === 'constant' ? [...policy.object.values] : [];
}

function conditionSlugs(condition: Condition): PermissionSlug[] {
  switch (condition.kind) {
    case 'true':
    case 'regex':
      return [];
    case 'and':
    case 'or':
      return condition.conditions.flatMap(conditionSlugs);
    case 'not':
      return conditionSlugs(condition.condition);
    case 'comparison': {
      const isPermissions = (side: ConditionValue) => side.kind === 'person' && side.fact.kind === 'permissions';

      const other = isPermissions(condition.left)
        ? condition.right
        : isPermissions(condition.right)
          ? condition.left
          : undefined;

      if (other?.kind !== 'static') return [];

      const { value } = other;

      return (Array.isArray(value) ? value : [value]).filter((each): each is string => typeof each === 'string');
    }
  }
}
