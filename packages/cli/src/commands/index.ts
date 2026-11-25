import { createClient, createPlatformClient, type Client } from '@osdk/client';
import { OntologiesV2 } from '@osdk/foundry.ontologies';
import type { ClientConfig } from '@ericbragas/ontos-service/client-config';
import { storeKey, TOKEN_VARIABLES } from '../auth/keys.ts';
import { login, testUserCredentials, testUserLogin } from '../auth/login.ts';
import { logout, tokenProvider } from '../auth/provider.ts';
import { CliError, shared } from '../cliError.ts';
import { failureOf, withNoOrganizationStep } from '../errors.ts';
import { attempt, settle, type AsyncFallible, type Fallible, type Result as Settled } from '../fallible.ts';
import type { Io, Variables } from '../io.ts';
import type { Flags } from '../main.ts';
import { keptOntologies, metadataFetch } from '../metadataCache.ts';
import { publishApp } from '../publish.ts';
import { generateOsdk } from '../sdk/generate.ts';
import { serviceFetch } from '../serviceFetch.ts';
import { cliSettings, readClientConfig, resolveTarget, type Target } from '../targets.ts';
import { validateApp } from '../validate/index.ts';
import { describeOntology } from './describe.ts';
import { runDev } from './dev.ts';
import { initProject } from './init.ts';
import { chooseOntology, INSTALL_USAGE, installProduct } from './ontologies.ts';
import { aggregate, aggregateOptions, apply, history, objects } from './read.ts';
import { ok, type CommandSpec, type Connection, type Context, type LocalCommandSpec, type Result } from './types.ts';

export type { Context, Result };

type Flag = keyof Flags;

export const COMMANDS = {
  init: {
    flags: ['force'],
    minArgs: 0,
    args: 1,
    usage: 'init [dir] [--force]',
    local: true,
    run: async function* (io: Io, [dir], flags, version): AsyncFallible<Result, CliError> {
      return ok(yield* initProject(io, dir, flags, version));
    },
  },
  dev: {
    flags: ['port', 'host', 'database-url', 'token', 'product-rid'],
    minArgs: 0,
    args: 0,
    usage: 'dev [--port <port>] [--host <host>] [--database-url <url>] [--token <token>] [--product-rid <rid>]',
    local: true,
    run: (io: Io, _args, flags) => runDev(io, flags),
  },
  login: {
    flags: ['org'],
    minArgs: 0,
    args: 0,
    usage: 'login [--org <id>]',
    run: async function* ({ target, io, flags: { org } }: Context): AsyncFallible<Result, CliError> {
      if (org === '') return yield new CliError('--org needs an Organization ID: ontos login --org <id>');

      const credentials = target.testUser ? yield* testUserCredentials(io.env) : undefined;
      const config = yield* readClientConfig(target, io);

      const signedIn = yield* credentials
        ? testUserLogin(target, config, credentials, org, io)
        : login(target, config, org, io);

      return ok({ loggedIn: storeKey(target), ...signedIn });
    },
  },
  logout: {
    flags: [],
    minArgs: 0,
    args: 0,
    usage: 'logout',
    run: async function* ({ target, io }: Context): AsyncFallible<Result, CliError> {
      yield* logout(target, io);

      return ok({ loggedOut: storeKey(target) });
    },
  },
  install: {
    flags: ['api-name', 'display-name'],
    minArgs: 1,
    args: 1,
    usage: INSTALL_USAGE,
    noTestUser: true,
    run: async function* (context, [product = '']): AsyncFallible<Result, CliError> {
      return ok(yield* installProduct(context, product));
    },
  },
  describe: {
    flags: ['ontology'],
    minArgs: 0,
    args: 1,
    usage: 'describe [name] [--ontology <apiName>]',
    run: (context, [name]) =>
      withClient(context, async function* (client, ontologyRid, { productRid }): AsyncFallible<Result, CliError> {
        const metadata = yield* attempt(() => OntologiesV2.getFullMetadata(client, ontologyRid), failureOf);

        return ok(yield* describeOntology(metadata, name, productRid));
      }),
  },
  objects: {
    flags: ['ontology', 'where', 'order-by', 'select', 'link', 'page-size', 'page-token'],
    minArgs: 1,
    args: 2,
    usage: 'objects <ObjectType> [<primary key>] [--link <link>] [--ontology <apiName>]',
    run: (context, [name = '', primaryKey]) =>
      withClient(context, async function* (client): AsyncFallible<Result, CliError> {
        return ok(yield* objects(client, name, primaryKey, context.flags));
      }),
  },
  aggregate: {
    flags: ['ontology', 'where', 'select', 'group-by'],
    minArgs: 1,
    args: 1,
    usage: 'aggregate <ObjectType> [--ontology <apiName>]',
    run: async function* (context, [name = '']): AsyncFallible<Result, CliError> {
      const options = yield* aggregateOptions(context.flags);

      return yield* withClient(context, async function* (client): AsyncFallible<Result, CliError> {
        return ok(yield* aggregate(client, name, options));
      });
    },
  },
  apply: {
    flags: ['ontology', 'parameters', 'validate-only'],
    minArgs: 1,
    args: 1,
    usage: 'apply <ActionType> --parameters <JSON> [--ontology <apiName>]',
    run: (context, [name = '']) => withClient(context, (client) => apply(client, name, context.flags)),
  },
  history: {
    flags: ['ontology', 'page-token'],
    minArgs: 1,
    args: 2,
    usage: 'history <ObjectType> [<primary key>] [--ontology <apiName>]',
    run: (context, [name = '', primaryKey]) =>
      withClient(context, async function* (client, ontologyRid): AsyncFallible<Result, CliError> {
        return ok(yield* history(client, ontologyRid, name, primaryKey, context.flags, context.io));
      }),
  },
  validate: {
    flags: ['local', 'base'],
    minArgs: 0,
    args: 0,
    usage: 'validate [--local | --base <ref>]',
    run: async function* (context: Context): AsyncFallible<Result, CliError> {
      return ok(yield* validateApp(context));
    },
  },
  publish: {
    flags: ['skip-sdk-package'],
    minArgs: 0,
    args: 0,
    usage: 'publish [--skip-sdk-package]',
    run: async function* (context: Context): AsyncFallible<Result, CliError> {
      return ok(yield* publishApp(context, false));
    },
  },
  'generate-osdk': {
    flags: ['product-rid'],
    minArgs: 0,
    args: 0,
    usage: 'generate-osdk [--product-rid <rid>]',
    local: true,
    run: async function* (io: Io, _args, flags): AsyncFallible<Result, CliError> {
      return ok(yield* generateOsdk(io, { productRid: flags['product-rid'] }));
    },
  },
} satisfies Record<string, CommandSpec | LocalCommandSpec>;

export type Command = keyof typeof COMMANDS;

const TARGET_FLAGS: readonly Flag[] = ['app', 'env', 'url', 'test-user'];
const GLOBAL_FLAGS: readonly Flag[] = ['json', 'help'];

function* checkCommandLine(command: Command, args: readonly string[], flags: Flags): Fallible<void, CliError> {
  const spec: CommandSpec | LocalCommandSpec = COMMANDS[command];

  for (const flag of Object.keys(flags) as Flag[]) {
    if (GLOBAL_FLAGS.includes(flag)) continue;

    const targetFlag = spec.local !== true && TARGET_FLAGS.includes(flag) && !(flag === 'test-user' && spec.noTestUser);

    if (targetFlag || spec.flags.includes(flag)) continue;

    return yield new CliError(`ontos ${command} does not take --${flag}.`);
  }

  if (args.length < spec.minArgs || args.length > spec.args) return yield new CliError(`Usage: ontos ${spec.usage}`);
}

export async function* runCommand(
  command: Command,
  args: readonly string[],
  flags: Flags,
  io: Io,
  version: string,
  run: (args: readonly string[], io: Io) => Promise<number>,
): AsyncFallible<Result, CliError> {
  yield* checkCommandLine(command, args, flags);

  const spec: CommandSpec | LocalCommandSpec = COMMANDS[command];

  if (spec.local === true) return yield* spec.run(io, args, flags, version);

  const settings = cliSettings(io);
  const target = yield* resolveTarget(flags, settings);
  const preset = target.testUser ? TOKEN_VARIABLES.find((name) => settings[name]) : undefined;

  if (preset)
    return yield new CliError(
      `--test-user calls as the stored test user, so it does not take ${preset}: unset ${preset}, or remove --test-user.`,
    );

  let connection: Promise<Settled<Connection, CliError>> | undefined;

  const context: Context = {
    target,
    io,
    flags,
    version,
    run,
    connection: () => shared((connection ??= settle(connect(target, io, settings)))),
  };

  const ran = await settle(spec.run(context, args));

  if (ran.ok) return ran.value;

  return yield failureOf(withNoOrganizationStep(ran.error, target));
}

async function* connect(target: Target, io: Io, settings: Variables): AsyncFallible<Connection, CliError> {
  const config = yield* readClientConfig(target, io);

  return { config, token: tokenProvider(target, config, io, settings) };
}

async function* withClient(
  context: Context,
  call: (client: Client, ontologyRid: string, config: ClientConfig) => AsyncFallible<Result, CliError>,
): AsyncFallible<Result, CliError> {
  const { config, token } = yield* context.connection();
  const fetch = metadataFetch(serviceFetch(context.io));
  const listToken = yield* attempt(() => token(), failureOf);

  const { data } = yield* keptOntologies(context.target.url, listToken, () =>
    OntologiesV2.list(createPlatformClient(context.target.url, () => Promise.resolve(listToken), undefined, fetch)),
  );

  const { rid } = yield* chooseOntology(data, context.flags.ontology);

  return yield* call(createClient(context.target.url, rid, token, undefined, fetch), rid, config);
}
