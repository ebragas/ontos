import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import type ts from 'typescript';
import { CliError } from '../cliError.ts';
import { failureOf } from '../errors.ts';
import { attempt, type AsyncFallible, type Fallible } from '../fallible.ts';

type TypeScript = typeof ts;

export const DOMAIN_MODULE_NAME = 'domain';

export interface DomainFile {
  readonly path: string;
  readonly bytes: Buffer;
}

const TEST_FILE = /\.(?:test|test-utils|fixture)\.ts$/;

function collectFiles(domainRoot: string, folder: string, collected: DomainFile[]): void {
  const entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;

    const full = join(folder, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') collectFiles(domainRoot, full, collected);

      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.ts') || TEST_FILE.test(entry.name)) continue;

    const path = relative(domainRoot, full).split(sep).join('/');

    collected.push({ path, bytes: readFileSync(full) });
  }
}

interface ModuleRef {
  readonly specifier: string | undefined;
  readonly typeOnly: boolean;
}

function isTypeOnlyImport(tsModule: TypeScript, node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;

  if (!clause) return false;

  if (clause.isTypeOnly) return true;

  if (clause.name) return false;

  return (
    clause.namedBindings !== undefined &&
    tsModule.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(tsModule: TypeScript, node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;

  return (
    node.exportClause !== undefined &&
    tsModule.isNamedExports(node.exportClause) &&
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((element) => element.isTypeOnly)
  );
}

function moduleRefs(tsModule: TypeScript, source: ts.SourceFile): ModuleRef[] {
  const refs: ModuleRef[] = [];

  const visit = (node: ts.Node): void => {
    if (tsModule.isImportDeclaration(node) && tsModule.isStringLiteral(node.moduleSpecifier)) {
      refs.push({ specifier: node.moduleSpecifier.text, typeOnly: isTypeOnlyImport(tsModule, node) });
    } else if (
      tsModule.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      tsModule.isStringLiteral(node.moduleSpecifier)
    ) {
      refs.push({ specifier: node.moduleSpecifier.text, typeOnly: isTypeOnlyExport(tsModule, node) });
    } else if (
      tsModule.isImportEqualsDeclaration(node) &&
      tsModule.isExternalModuleReference(node.moduleReference) &&
      tsModule.isStringLiteral(node.moduleReference.expression)
    ) {
      refs.push({ specifier: node.moduleReference.expression.text, typeOnly: node.isTypeOnly });
    } else if (tsModule.isCallExpression(node) && node.expression.kind === tsModule.SyntaxKind.ImportKeyword) {
      const [first] = node.arguments;

      refs.push({
        specifier: first && tsModule.isStringLiteralLike(first) ? first.text : undefined,
        typeOnly: false,
      });
    } else if (
      tsModule.isImportTypeNode(node) &&
      tsModule.isLiteralTypeNode(node.argument) &&
      tsModule.isStringLiteral(node.argument.literal)
    ) {
      refs.push({ specifier: node.argument.literal.text, typeOnly: true });
    }

    tsModule.forEachChild(node, visit);
  };

  visit(source);

  return refs;
}

const isAllowedTypePeer = (specifier: string): boolean =>
  specifier === '@osdk/client' || specifier.startsWith('@osdk/client/');

function* checkImports(tsModule: TypeScript, file: DomainFile): Fallible<void, CliError> {
  const source = tsModule.createSourceFile(file.path, file.bytes.toString('utf8'), tsModule.ScriptTarget.Latest, true);
  const label = `${DOMAIN_MODULE_NAME}/${file.path}`;

  for (const ref of moduleRefs(tsModule, source)) {
    if (ref.specifier === undefined) {
      return yield new CliError(
        `${label} uses a dynamic import(). Code in ${DOMAIN_MODULE_NAME}/ can import only relative files in ${DOMAIN_MODULE_NAME}/ and types from @osdk/client.`,
      );
    }

    if (ref.specifier.startsWith('./') || ref.specifier.startsWith('../')) {
      const resolved = posix.normalize(posix.join(posix.dirname(file.path), ref.specifier));

      if (resolved === '..' || resolved.startsWith('../')) {
        return yield new CliError(
          `${label} imports ${JSON.stringify(ref.specifier)}, which leaves ${DOMAIN_MODULE_NAME}/. Keep all code that ${DOMAIN_MODULE_NAME}/ imports inside ${DOMAIN_MODULE_NAME}/.`,
        );
      }

      continue;
    }

    if (ref.typeOnly && isAllowedTypePeer(ref.specifier)) continue;

    return yield new CliError(
      `${label} imports ${JSON.stringify(ref.specifier)}. Code in ${DOMAIN_MODULE_NAME}/ can import only relative files in ${DOMAIN_MODULE_NAME}/ and types from @osdk/client.`,
    );
  }
}

export async function* readDomain(appRoot: string): AsyncFallible<readonly DomainFile[] | undefined, CliError> {
  const domainRoot = join(appRoot, DOMAIN_MODULE_NAME);
  const entry = join(domainRoot, 'index.ts');

  if (!lstatSync(entry, { throwIfNoEntry: false })?.isFile()) return undefined;

  const files: DomainFile[] = [];

  collectFiles(domainRoot, domainRoot, files);

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const { default: tsModule } = yield* attempt(() => import('typescript'), failureOf);

  for (const file of files) yield* checkImports(tsModule, file);

  return files;
}

export function writeDomainFiles(folder: string, domain: readonly DomainFile[]): void {
  const domainRoot = join(folder, DOMAIN_MODULE_NAME);

  for (const file of domain) {
    const dest = join(domainRoot, file.path);

    mkdirSync(dirname(dest), { recursive: true });

    writeFileSync(dest, file.bytes);
  }
}
