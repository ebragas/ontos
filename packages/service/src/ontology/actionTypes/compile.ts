import { each, type Fallible } from '../../errors/index.ts';
import type {
  ActionTypeApiName,
  CompiledActionType,
  CompiledParameter,
  FunctionLogic,
  ParameterId,
  Rule,
  RuleLogic,
} from '../compiled/index.ts';
import { CompileError } from '../compiled/stored.ts';
import { actionTypeDisplay, actionTypeStatus } from '../model/display.ts';
import { checkActionTypeApiName } from '../model/names.ts';
import { array, isRecord, record, string, tag, type JsonRecord } from '../model/shape.ts';
import { allowedValues, optionalLength } from '../parameters/allowed.ts';
import { isList, parameterType } from '../parameters/types.ts';
import { actionTypeRid } from '../rids.ts';
import { objectParameterProperty, type ActionTypeContext, type Parameters } from './context.ts';
import { criteria } from './criteria.ts';
import { compileRule } from './rules.ts';

export function* compileActionTypes(
  actionTypes: JsonRecord,
  context: ActionTypeContext,
): Fallible<Map<ActionTypeApiName, CompiledActionType>, CompileError> {
  const compiled = new Map<ActionTypeApiName, CompiledActionType>();

  for (const [key, value] of Object.entries(actionTypes)) {
    const path = `ontology.actionTypes.${key}`;

    const actionType = yield* compileActionType(
      yield* record((yield* record(value, path))['actionType'], `${path}.actionType`),
      `${path}.actionType`,
      context,
    );

    if (compiled.has(actionType.apiName)) {
      return yield new CompileError(
        `2 Action Types have the API name ${actionType.apiName}. An Action Type API name is unique across the Action Types of the Ontology.`,
      );
    }

    compiled.set(actionType.apiName, actionType);
  }

  return compiled;
}

function* compileActionType(
  actionType: JsonRecord,
  path: string,
  context: ActionTypeContext,
): Fallible<CompiledActionType, CompileError> {
  const metadata = yield* record(actionType['metadata'], `${path}.metadata`);
  const apiName = yield* string(metadata['apiName'], `${path}.metadata.apiName`);

  yield* checkActionTypeApiName(apiName);

  const owner = `Action Type ${apiName}`;
  const logicPath = `${path}.actionTypeLogic`;
  const actionTypeLogic = yield* record(actionType['actionTypeLogic'], logicPath);

  const rules = yield* array(
    (yield* record(actionTypeLogic['logic'], `${logicPath}.logic`))['rules'],
    `${logicPath}.logic.rules`,
  );

  const validationPath = `${logicPath}.validation`;
  const validation = yield* record(actionTypeLogic['validation'], validationPath);

  const functionRules = rules.filter((rule) => isRecord(rule) && rule['type'] === 'functionRule');
  let parameters: Parameters;
  let logic: RuleLogic | FunctionLogic;

  if (functionRules.length > 0) {
    if (rules.length > 1) {
      return yield new CompileError(
        `${owner} has a Function rule and ${rules.length - 1} other rules. An Action Type with a Function rule has no other rule.`,
      );
    }

    const functionRule = yield* record(
      (yield* record(rules[0], `${logicPath}.logic.rules.0`))['functionRule'],
      `${logicPath}.logic.rules.0.functionRule`,
    );

    const fn = yield* string(functionRule['functionRid'], `${logicPath}.logic.rules.0.functionRule.functionRid`);
    const named = context.functions.get(fn);

    if (!named) {
      return yield new CompileError(
        `${owner} has a Function rule for the Function ${fn}, which the version does not have. A function-backed Action needs its Function.`,
      );
    }

    if (named.kind === 'query') {
      return yield new CompileError(
        `${owner} has a Function rule for ${fn}, which returns a value. A function-backed Action runs an edit Function, which returns a list of edits.`,
      );
    }

    parameters = named.parameters;

    logic = { kind: 'function', function: fn };
  } else {
    parameters = yield* ruleParameters(metadata, validation, path, owner, context);

    logic = {
      kind: 'rules',
      rules: yield* each(rules, function* (rule, i): Fallible<Rule, CompileError> {
        return yield* compileRule(rule, `${logicPath}.logic.rules.${i}`, owner, parameters, context);
      }),
    };
  }

  return {
    apiName,
    rid: actionTypeRid(context.namespace, apiName),
    status: yield* actionTypeStatus(metadata['status'], `${path}.metadata.status`),
    display: yield* actionTypeDisplay(metadata, `${path}.metadata`),
    parameters,
    criteria: yield* criteria(
      yield* record(validation['actionTypeLevelValidation'], `${validationPath}.actionTypeLevelValidation`),
      `${validationPath}.actionTypeLevelValidation`,
      owner,
      parameters,
      context,
    ),
    logic,
  };
}

function* ruleParameters(
  metadata: JsonRecord,
  validation: JsonRecord,
  path: string,
  owner: string,
  context: ActionTypeContext,
): Fallible<Parameters, CompileError> {
  const objectTypes = new Set(context.objectTypes.keys());

  const validations = yield* record(
    validation['parameterValidations'],
    `${path}.actionTypeLogic.validation.parameterValidations`,
  );

  const parameters = new Map<ParameterId, CompiledParameter>();

  for (const [id, value] of Object.entries(yield* record(metadata['parameters'], `${path}.metadata.parameters`))) {
    const parameterPath = `${path}.metadata.parameters.${id}`;
    const parameterOwner = `Parameter ${id} of ${owner}`;

    const type = yield* parameterType(
      (yield* record(value, parameterPath))['type'],
      `${parameterPath}.type`,
      parameterOwner,
      objectTypes,
    );

    const blockPath = `${path}.actionTypeLogic.validation.parameterValidations.${id}`;
    const block = yield* record(validations[id], blockPath);

    if ((yield* array(block['conditionalOverrides'], `${blockPath}.conditionalOverrides`)).length > 0) {
      return yield new CompileError(`${parameterOwner} has conditional overrides, which V1 does not have.`);
    }

    const structFieldValidations = block['structFieldValidations'];

    if (
      structFieldValidations !== undefined &&
      structFieldValidations !== null &&
      Object.keys(yield* record(structFieldValidations, `${blockPath}.structFieldValidations`)).length > 0
    ) {
      return yield new CompileError(
        `${parameterOwner} has struct field validations, which V1 does not have on a rule-backed Action.`,
      );
    }

    const rules = yield* record(
      (yield* record(block['defaultValidation'], `${blockPath}.defaultValidation`))['validation'],
      `${blockPath}.defaultValidation.validation`,
    );

    const rulesPath = `${blockPath}.defaultValidation.validation`;
    const required = yield* record(rules['required'], `${rulesPath}.required`);
    const requiredKind = yield* tag(required, `${rulesPath}.required`);

    const parameter: { -readonly [K in keyof CompiledParameter]: CompiledParameter[K] } = {
      id,
      type,
      required: requiredKind === 'required',
      allowed: yield* allowedValues(rules['allowedValues'], `${rulesPath}.allowedValues`, parameterOwner, type),
    };

    if (requiredKind === 'listLengthValidation') {
      const lengthPath = `${rulesPath}.required.listLengthValidation`;

      if (!isList(type))
        return yield new CompileError(
          `${parameterOwner} has a list length, and its type ${type.kind} is not a list. Only a list parameter has a list length.`,
        );

      const length = yield* record(required['listLengthValidation'], lengthPath);
      const min = yield* optionalLength(length['minLength'], `${lengthPath}.minLength`);
      const max = yield* optionalLength(length['maxLength'], `${lengthPath}.maxLength`);

      if (min !== undefined && max !== undefined && min > max) {
        return yield new CompileError(
          `${parameterOwner} has the list length minimum ${min}, which is more than its maximum ${max}.`,
        );
      }

      parameter.required = (min ?? 0) >= 1;
      parameter.listLength = { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
    } else if (requiredKind !== 'required' && requiredKind !== 'notRequired') {
      return yield new CompileError(
        `${parameterOwner} has the required setting ${requiredKind}, which V1 does not have.`,
      );
    }

    parameters.set(id, parameter);
  }

  for (const [id, parameter] of parameters) {
    const blockPath = `${path}.actionTypeLogic.validation.parameterValidations.${id}`;

    const display = (yield* record(
      (yield* record(validations[id], blockPath))['defaultValidation'],
      `${blockPath}.defaultValidation`,
    ))['display'];

    const prefill = isRecord(display) ? display['prefill'] : undefined;

    if (prefill === undefined || prefill === null) continue;

    parameters.set(id, {
      ...parameter,
      defaultValue: yield* compileDefaultValue(
        prefill,
        `${blockPath}.defaultValidation.display.prefill`,
        `Parameter ${id} of ${owner}`,
        parameters,
        context,
      ),
    });
  }

  return parameters;
}

function* compileDefaultValue(
  ir: unknown,
  path: string,
  owner: string,
  parameters: Parameters,
  context: ActionTypeContext,
): Fallible<NonNullable<CompiledParameter['defaultValue']>, CompileError> {
  const kind = yield* tag(ir, path);

  if (kind !== 'objectParameterPropertyValue')
    return yield new CompileError(`${owner} has the default value kind ${kind}, which V1 does not have.`);

  return {
    kind: 'objectProperty',
    ...(yield* objectParameterProperty((yield* record(ir, path))[kind], `${path}.${kind}`, owner, parameters, context)),
  };
}
