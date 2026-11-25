import { ontologyMetadata } from '@ericbragas/ontos-service/convert';
import type { OsdkSet } from '@ericbragas/ontos-service/publish';
import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type ts from 'typescript';
import { readApp, readOsdkSet, type App } from '../app.ts';
import { installedBin, makeIr, runNode } from '../appRunner.ts';
import { CliError } from '../cliError.ts';
import { DEFAULT_DEV_PRODUCT_RID, isProductRid, readDeploymentFile } from '../deploymentFile.ts';
import { failureOf } from '../errors.ts';
import { attempt, invariant, settle, type AsyncFallible, type Fallible } from '../fallible.ts';
import { hasFunctions } from '../functions/discover.ts';
import { appFunctions } from '../functions/index.ts';
import type { Io } from '../io.ts';
import { DOMAIN_MODULE_NAME, readDomain, writeDomainFiles, type DomainFile } from './domain.ts';
import { type ModuleEnvironments, SERVICE_MODULE_NAME, serviceModuleText } from './serviceModule.ts';

type TypeScript = typeof ts;

const SDK_PEERS = ['@osdk/client'] as const;

const DOMAIN_EXPORT = {
  types: `./dist/${DOMAIN_MODULE_NAME}/index.d.ts`,
  import: `./dist/${DOMAIN_MODULE_NAME}/index.js`,
} as const;

function baseSdkFields(hasDomain: boolean) {
  return {
    type: 'module' as const,
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      [`./${SERVICE_MODULE_NAME}`]: {
        types: `./dist/${SERVICE_MODULE_NAME}.d.ts`,
        import: `./dist/${SERVICE_MODULE_NAME}.js`,
      },
      ...(hasDomain ? { [`./${DOMAIN_MODULE_NAME}`]: DOMAIN_EXPORT } : {}),
    },
    scripts: { build: 'tsc' },
  };
}

const formatManifest = (manifest: object): string => `${JSON.stringify(manifest, null, 2)}\n`;

function localSdkManifest(hasDomain: boolean) {
  return {
    name: 'ontology',
    version: '0.0.0',
    private: true,
    ...baseSdkFields(hasDomain),
  };
}

export const LOCAL_SDK_PACKAGE_JSON = formatManifest(localSdkManifest(false));

export type SdkFields = ReturnType<typeof sdkManifest>;

export function* sdkFields(osdkSet: OsdkSet, hasDomain = false): Fallible<SdkFields, CliError> {
  const peerDependencies: Record<string, string> = {};

  for (const name of SDK_PEERS) {
    const version = osdkSet[name];

    if (!version)
      return yield new CliError(
        `The app installs no ${name}. The Ontology SDK declares it as a peer dependency, at the version of the OSDK set.`,
      );

    peerDependencies[name] = version;
  }

  return sdkManifest(peerDependencies, hasDomain);
}

function sdkManifest(peerDependencies: Record<string, string>, hasDomain: boolean) {
  return {
    ...baseSdkFields(hasDomain),
    peerDependencies,
    devDependencies: { typescript: '^5.0.0' },
  };
}

const SDK_COMPILER_OPTIONS = {
  target: 'ES2022',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  declaration: true,
  declarationMap: true,
  sourceMap: true,
  skipLibCheck: true,
  rootDir: '.',
  outDir: 'dist',
};

const sdkCompilerOptions = (hasDomain: boolean) =>
  hasDomain ? { ...SDK_COMPILER_OPTIONS, rewriteRelativeImportExtensions: true } : SDK_COMPILER_OPTIONS;

function formatDiagnostic(tsModule: TypeScript, folder: string, diagnostic: ts.Diagnostic): string {
  const text = tsModule.flattenDiagnosticMessageText(diagnostic.messageText, '\n');

  if (!diagnostic.file || diagnostic.start === undefined) return text;

  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);

  return `${relative(folder, diagnostic.file.fileName).split(sep).join('/')}:${line + 1}:${character + 1}: ${text}`;
}

async function* compileSdk(
  folder: string,
  appRoot: string,
  domain: readonly DomainFile[] | undefined,
): AsyncFallible<void, CliError> {
  const { default: tsModule } = yield* attempt(() => import('typescript'), failureOf);
  const compilerOptions = sdkCompilerOptions(domain !== undefined);
  const { options, errors } = tsModule.convertCompilerOptionsFromJson(compilerOptions, folder);

  invariant(errors.length === 0, tsModule.flattenDiagnosticMessageText(errors[0]?.messageText, '\n'));

  const domainRoot = join(folder, DOMAIN_MODULE_NAME);
  const domainNames = domain ? domain.map((file) => join(domainRoot, file.path)) : [];
  const host = tsModule.createCompilerHost(options);

  if (domain) {
    const cache = tsModule.createModuleResolutionCache(folder, (fileName) => fileName, options);
    const fallbackFile = join(appRoot, 'package.json');

    host.resolveModuleNameLiterals = (literals, containingFile, _redirected, opts) =>
      literals.map((literal) => {
        const first = tsModule.resolveModuleName(literal.text, containingFile, opts, host, cache);

        if (first.resolvedModule || literal.text.startsWith('.')) return first;

        return tsModule.resolveModuleName(literal.text, fallbackFile, opts, host, cache);
      });
  }

  const program = tsModule.createProgram({
    rootNames: [join(folder, 'index.ts'), join(folder, `${SERVICE_MODULE_NAME}.ts`), ...domainNames],
    options,
    host,
  });

  if (domain) {
    const domainDiagnostics = domainNames.flatMap((name) => {
      const file = program.getSourceFile(name);

      return file ? tsModule.getPreEmitDiagnostics(program, file) : [];
    });

    if (domainDiagnostics.length > 0) {
      return yield new CliError(
        `The ${DOMAIN_MODULE_NAME}/ code did not compile:\n${domainDiagnostics.map((diagnostic) => formatDiagnostic(tsModule, folder, diagnostic)).join('\n')}`,
      );
    }
  }

  const { emitSkipped, diagnostics } = program.emit();

  invariant(
    !emitSkipped,
    `The Ontology SDK did not compile: ${diagnostics.map((diagnostic) => tsModule.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join(' ')}`,
  );
}

export function generatorArgs(ontologyPath: string, folder: string): string[] {
  return [
    'unstable',
    'typescript',
    'generate',
    '--ontologyPath',
    ontologyPath,
    '--outDir',
    folder,
    '--version',
    '0.0.0',
    '--packageType',
    'module',
    '--clean',
    '--skipPackageJsonUpdate',
  ];
}

export async function* writeSdk(
  app: App,
  metadata: OntologyFullMetadata,
  deployment: ModuleEnvironments,
  folder: string,
  manifest: object,
  domain?: readonly DomainFile[],
): AsyncFallible<void, CliError> {
  const script = yield* installedBin(app, '@osdk/cli', 'osdk');
  const temp = mkdtempSync(join(tmpdir(), 'ontology-metadata-'));

  try {
    const ontologyPath = join(temp, 'ontology-metadata.json');

    writeFileSync(ontologyPath, JSON.stringify(metadata));

    yield* runNode(script, generatorArgs(ontologyPath, folder), app.root);

    writeFileSync(join(folder, `${SERVICE_MODULE_NAME}.ts`), yield* serviceModuleText(metadata, deployment));

    if (domain) writeDomainFiles(folder, domain);

    writeFileSync(join(folder, 'package.json'), formatManifest(manifest));

    const compilerOptions = sdkCompilerOptions(domain !== undefined);

    const include = domain
      ? ['index.ts', `${SERVICE_MODULE_NAME}.ts`, 'ontology', DOMAIN_MODULE_NAME]
      : ['index.ts', `${SERVICE_MODULE_NAME}.ts`, 'ontology'];

    writeFileSync(join(folder, 'tsconfig.json'), `${JSON.stringify({ compilerOptions, include }, null, 2)}\n`);

    yield* compileSdk(folder, app.root, domain);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function* metadataOf(...args: Parameters<typeof ontologyMetadata>): Fallible<OntologyFullMetadata, CliError> {
  const metadata = settle(ontologyMetadata(...args));

  if (!metadata.ok) return yield failureOf(metadata.error);

  return metadata.value;
}

export async function* generateOsdk(
  io: Pick<Io, 'cwd'>,
  options: { readonly productRid?: string | undefined } = {},
): AsyncFallible<{ readonly osdkOutput: string; readonly passes: number }, CliError> {
  const app = yield* readApp(io.cwd);

  if (!app.osdkOutput)
    return yield new CliError(
      `${app.configFile} has no osdkOutput. generate-osdk writes the Ontology SDK to <osdkOutput>/ontology/.`,
    );

  if (options.productRid !== undefined && !isProductRid(options.productRid)) {
    return yield new CliError('--product-rid must have the form ri.ontology.main.ontology.<UUID>.');
  }

  const folder = resolve(app.root, app.osdkOutput, 'ontology');
  const rel = relative(app.root, folder);

  if (rel === '' || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    return yield new CliError(`osdkOutput must stay inside the app folder, not ${app.osdkOutput}.`);
  }

  const hasDeployment = existsSync(join(app.root, '.ontology', 'deployment.json'));
  const deploymentFile = hasDeployment ? (yield* readDeploymentFile(app.root)).file : undefined;
  const productRid = options.productRid ?? deploymentFile?.productRid ?? DEFAULT_DEV_PRODUCT_RID;
  const environments: ModuleEnvironments = deploymentFile ?? {};
  const domain = yield* readDomain(app.root);
  const manifest = localSdkManifest(domain !== undefined);
  const ir = yield* makeIr(app);
  const osdkSet = readOsdkSet(app);

  yield* writeSdk(app, yield* metadataOf({ ir, osdkSet }, productRid), environments, folder, manifest, domain);

  if (!hasFunctions(app.functions)) return { osdkOutput: relative(app.root, folder), passes: 1 };

  const functions = yield* appFunctions(app, ir);

  yield* writeSdk(
    app,
    yield* metadataOf({ ir, osdkSet, ...(functions ? { functions } : {}) }, productRid),
    environments,
    folder,
    manifest,
    domain,
  );

  return { osdkOutput: relative(app.root, folder), passes: 2 };
}
