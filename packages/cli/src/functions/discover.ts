import type { PublishRequest } from '@ericbragas/ontos-service/publish';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type ts from 'typescript';
import { CliError } from '../cliError.ts';
import { failureOf } from '../errors.ts';
import { attempt, type AsyncFallible, type Fallible } from '../fallible.ts';
import {
  lfText,
  location,
  tag,
  TypeResolver,
  type CliDiscoveredFunction,
  type CliDiscoveredInput,
} from './typeResolver.ts';

export type { CliDiscoveredFunction };

type TypeScript = typeof ts;

const functionsFolder = (component: string): string => join(component, 'src', 'functions');

function* findTsconfig(folder: string): Fallible<string, CliError> {
  const file = [join(folder, 'tsconfig.json'), join(dirname(folder), 'tsconfig.json')].find((path) => existsSync(path));

  if (!file)
    return yield new CliError(`No tsconfig.json in ${folder} or its parent folder. Function discovery needs one.`);

  return file;
}

export function hasFunctions(component: string | undefined): component is string {
  const folder = component === undefined ? undefined : functionsFolder(component);

  return (
    folder !== undefined &&
    existsSync(folder) &&
    readdirSync(folder, { recursive: true }).some((name) => /\.[cm]?ts$/.test(String(name)))
  );
}

function paramDescription(tsModule: TypeScript, parameter: ts.ParameterDeclaration): string {
  return tsModule
    .getJSDocParameterTags(parameter)
    .map((tag) => lfText(tsModule.getTextOfJSDocComment(tag.comment) ?? '').replace(/^-(\s+|$)/, ''))
    .filter((text) => text !== '')
    .join('\n');
}

function functionOf(tsModule: TypeScript, symbol: ts.Symbol): ts.SignatureDeclaration | undefined {
  for (const declaration of symbol.getDeclarations() ?? []) {
    if (tsModule.isFunctionDeclaration(declaration)) return declaration;

    const value = tsModule.isVariableDeclaration(declaration)
      ? declaration.initializer
      : tsModule.isExportAssignment(declaration)
        ? declaration.expression
        : undefined;

    if (value && (tsModule.isArrowFunction(value) || tsModule.isFunctionExpression(value))) return value;
  }

  return undefined;
}

function configApiName(tsModule: TypeScript, exports: readonly ts.Symbol[]): string | undefined {
  const config = exports.find((symbol) => symbol.getName() === 'config');
  const declaration = config?.getDeclarations()?.find(tsModule.isVariableDeclaration);
  let expression = declaration?.initializer;

  while (
    expression &&
    (tsModule.isAsExpression(expression) ||
      tsModule.isSatisfiesExpression(expression) ||
      tsModule.isParenthesizedExpression(expression))
  )
    expression = expression.expression;

  const initializer = expression && tsModule.isObjectLiteralExpression(expression) ? expression : undefined;

  const property = initializer?.properties.find(
    (entry): entry is ts.PropertyAssignment =>
      tsModule.isPropertyAssignment(entry) && entry.name.getText() === 'apiName',
  );

  return property && tsModule.isStringLiteralLike(property.initializer) ? property.initializer.text : undefined;
}

function* discoverFile(
  tsModule: TypeScript,
  resolver: TypeResolver,
  file: ts.SourceFile,
): Fallible<CliDiscoveredFunction | undefined, CliError> {
  const module = resolver.checker.getSymbolAtLocation(file);
  const exports = module ? resolver.checker.getExportsOfModule(module) : [];
  const found = exports.find((symbol) => symbol.getName() === 'default');

  if (!found) return undefined;

  const target = found.flags & tsModule.SymbolFlags.Alias ? resolver.checker.getAliasedSymbol(found) : found;
  const declaration = functionOf(tsModule, target);

  if (!declaration) return undefined;

  const fileName =
    file.fileName
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.[cm]?ts$/, '') ?? '';

  const declared =
    (tsModule.isFunctionDeclaration(declaration) || tsModule.isFunctionExpression(declaration)) && declaration.name
      ? declaration.name.text
      : undefined;

  if (declared !== undefined && declared !== fileName) {
    return yield new CliError(
      `${resolver.relativePath(file)}: the default export function ${declared} must have the name of its file, ${fileName}, as Functions "Discovery" specifies. Rename the function or the file.`,
    );
  }

  const configName = configApiName(tsModule, exports);

  if (configName !== undefined && configName !== fileName) {
    return yield new CliError(
      `${resolver.relativePath(file)}: the apiName of the config export, ${configName}, must be the file name, ${fileName}, as Functions "Code" specifies. Change the apiName or the file name.`,
    );
  }

  const apiName = fileName;
  const owner = `Function ${apiName}`;

  resolver.customTypes = {};

  const signature = resolver.checker.getSignatureFromDeclaration(declaration);

  if (!signature) return undefined;

  const inputs: CliDiscoveredInput[] = [];

  for (const [index, parameter] of declaration.parameters.entries()) {
    const name = parameter.name.getText(file);
    const type = resolver.checker.getTypeAtLocation(parameter);

    if (index === 0 && type.getSymbol()?.getName() === 'Client') {
      inputs.push({ name, dataType: tag('client', tag('ontologySdkClient')), constraints: [], required: true });

      continue;
    }

    const optional = parameter.questionToken !== undefined || parameter.initializer !== undefined;

    const { dataType, required, allowedValues } = yield* resolver.member(
      type,
      optional,
      `${owner}, input ${name}`,
      parameter.type,
    );

    const description = paramDescription(tsModule, parameter);

    inputs.push({
      name,
      dataType,
      required,
      constraints: [],
      ...(allowedValues ? { allowedValues } : {}),
      ...(description ? { description } : {}),
    });
  }

  let returned = signature.getReturnType();

  if (returned.getSymbol()?.getName() === 'Promise') returned = resolver.typeArguments(returned)[0] ?? returned;

  const isVoid = (returned.flags & (tsModule.TypeFlags.Void | tsModule.TypeFlags.Undefined)) !== 0;
  const [element] = resolver.checker.isArrayType(returned) ? resolver.typeArguments(returned) : [];
  const edit = element && resolver.isEdit(element) ? element : undefined;

  if (!isVoid && resolver.refusedOutput(returned)) return yield* resolver.unsupported(returned, `${owner}, output`);

  const output = isVoid
    ? { type: 'void' as const, void: {} }
    : {
        type: 'single' as const,
        single: { dataType: (yield* resolver.member(returned, false, `${owner}, output`)).dataType },
      };

  const documentation = lfText(tsModule.displayPartsToString(target.getDocumentationComment(resolver.checker)));

  return {
    customTypes: resolver.customTypes,
    inputs,
    output,
    locator: {
      type: 'typescript',
      typescript: { functionName: apiName, codeLocation: location(declaration), filePath: resolver.relativePath(file) },
    },
    ontologyProvenance: yield* resolver.provenance(edit, owner),
    ...(documentation ? { documentation } : {}),
  };
}

export async function* discoverFunctions(
  component: string,
  ir: PublishRequest['ir'],
): AsyncFallible<{ projectFolder: string; discovered: CliDiscoveredFunction[] }, CliError> {
  const folder = functionsFolder(component);
  const tsconfig = yield* findTsconfig(folder);
  const name = `The tsconfig.json of the Functions, ${relative(component, tsconfig).split(sep).join('/')},`;
  const text = readFileSync(tsconfig, 'utf8');

  if (text.trim() === '') return yield new CliError(`${name} is empty.`);

  const { default: tsModule } = yield* attempt(() => import('typescript'), failureOf);
  const { error } = tsModule.parseConfigFileTextToJson(tsconfig, text);

  if (error)
    return yield new CliError(`${name} is not valid: ${tsModule.flattenDiagnosticMessageText(error.messageText, ' ')}`);

  let unrecoverable: CliError | undefined;

  const parsed = tsModule.getParsedCommandLineOfConfigFile(
    tsconfig,
    {},
    {
      ...tsModule.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        unrecoverable ??= new CliError(
          `${tsconfig}: ${tsModule.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
        );
      },
    },
  );

  if (unrecoverable) return yield unrecoverable;

  if (!parsed) return yield new CliError(`${tsconfig} cannot be read.`);

  const program = tsModule.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const resolver = new TypeResolver(tsModule, program, dirname(tsconfig), ir);
  const inFolder = (file: string) => !relative(folder, file).startsWith('..');
  const discovered: CliDiscoveredFunction[] = [];

  for (const name of parsed.fileNames.filter(inFolder).sort()) {
    const file = program.getSourceFile(name);
    const found = file ? yield* discoverFile(tsModule, resolver, file) : undefined;

    if (found) discovered.push(found);
  }

  return { projectFolder: dirname(tsconfig), discovered };
}
