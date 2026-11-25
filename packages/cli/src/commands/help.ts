interface CommandHelpEntry {
  readonly usage: string;
  readonly summary: string;
  readonly options: readonly string[];
  readonly remote?: true;
}

const HELP_ENTRIES = {
  init: {
    usage: 'init [dir] [--force]',
    summary: 'Scaffold a minimal Ontos Ontology project.',
    options: ['--force                Overwrite existing files if present'],
  },
  dev: {
    usage: 'dev [--port <port>] [--host <host>] [--database-url <url>] [--token <token>] [--product-rid <rid>]',
    summary: 'Start a local PostgreSQL-backed Ontos service in dev mode.',
    options: [
      '--port <port>          Port to listen on (default: 8080)',
      '--host <host>          Host interface to bind (default: 127.0.0.1)',
      '--database-url <url>   PostgreSQL connection string (default: DATABASE_URL)',
      '--token <token>        Dev bearer token (default: ONTOS_DEV_TOKEN or ontos-dev-token)',
      '--product-rid <rid>    Product Ontology RID (default: local dev RID)',
    ],
  },
  login: {
    usage: 'login [--org <id>]',
    summary: 'Sign in to an Ontos deployment and store credentials.',
    options: [
      '--org <id>             Organization ID to sign into',
      '--test-user            Sign in with staging test user credentials from shell env',
    ],
    remote: true,
  },
  logout: {
    usage: 'logout',
    summary: 'Remove stored credentials for a deployment.',
    options: ['--test-user            Remove stored staging test user credentials'],
    remote: true,
  },
  install: {
    usage: 'install <product> --api-name <name> --display-name <name>',
    summary: 'Install a published Ontology product into an Organization.',
    options: [
      '--api-name <name>      API name for the installed Ontology',
      '--display-name <name>  Display name for the installed Ontology',
    ],
    remote: true,
  },
  describe: {
    usage: 'describe [name] [--ontology <apiName>]',
    summary: 'Inspect the full Ontology metadata or a single Object, Link, or Action Type.',
    options: ['--ontology <apiName>   Select an Ontology by API name'],
    remote: true,
  },
  objects: {
    usage: 'objects <ObjectType> [<primary key>] [--link <link>] [--ontology <apiName>]',
    summary: 'List Objects, fetch one Object by primary key, or traverse a Link.',
    options: [
      '--ontology <apiName>   Select an Ontology by API name',
      '--where <JSON>         Filter expression as JSON',
      '--order-by <JSON>      Sort specification as JSON',
      '--select <JSON>        Property list as JSON array',
      '--link <link>          Traverse a Link from the addressed Object',
      '--page-size <n>        Page size (1 to 10000)',
      '--page-token <token>   Pagination token from a previous page',
    ],
    remote: true,
  },
  aggregate: {
    usage: 'aggregate <ObjectType> --select <JSON> [--group-by <JSON>] [--where <JSON>]',
    summary: 'Run aggregations over an Object set.',
    options: [
      '--ontology <apiName>   Select an Ontology by API name',
      '--select <JSON>        Aggregation metrics as JSON object',
      '--group-by <JSON>      Grouping fields as JSON object',
      '--where <JSON>         Filter expression as JSON',
    ],
    remote: true,
  },
  apply: {
    usage: 'apply <ActionType> --parameters <JSON> [--validate-only] [--ontology <apiName>]',
    summary: 'Validate or execute an Action against the Ontology.',
    options: [
      '--ontology <apiName>   Select an Ontology by API name',
      '--parameters <JSON>    Action parameters as JSON object',
      '--validate-only        Validate without applying edits',
    ],
    remote: true,
  },
  history: {
    usage: 'history <ObjectType> [<primary key>] [--page-token <token>] [--ontology <apiName>]',
    summary: 'Read edit history for an Object Type or a specific Object.',
    options: [
      '--ontology <apiName>   Select an Ontology by API name',
      '--page-token <token>   Pagination token from a previous page',
    ],
    remote: true,
  },
  validate: {
    usage: 'validate [--local | --base <ref>]',
    summary: 'Validate the Ontology and Functions without publishing.',
    options: [
      '--local                Run validation against a local ephemeral service',
      '--base <ref>           Choose remote or local mode from Git diff against <ref>',
    ],
    remote: true,
  },
  publish: {
    usage: 'publish [--skip-sdk-package]',
    summary: 'Publish the Ontology and Functions to a service.',
    options: ['--skip-sdk-package     Publish without releasing an npm Ontology SDK package'],
    remote: true,
  },
  'generate-osdk': {
    usage: 'generate-osdk [--product-rid <rid>]',
    summary: 'Generate the local TypeScript Ontology SDK with no network calls.',
    options: ['--product-rid <rid>    Override or supply the Product Ontology RID'],
  },
} as const satisfies Record<string, CommandHelpEntry>;

export type HelpCommand = keyof typeof HELP_ENTRIES;

const GLOBAL_OPTIONS: readonly string[] = [
  '--url <url>            Target service URL (works without --app)',
  '--app <name>           Deployment app name (or ONTOLOGY_APP)',
  '--env <env>            Deployment environment: staging or production',
  '--org <id>             Organization ID (for login)',
  '--ontology <apiName>   Select an Ontology by API name',
  '--json                 Emit compact JSON output',
  '--version              Print the CLI version',
  '-h, --help             Show help',
];

const REMOTE_TARGET_OPTIONS: readonly string[] = [
  '--url <url>            Target service URL (works without --app)',
  '--app <name>           Deployment app name (or ONTOLOGY_APP)',
  '--env <env>            Deployment environment: staging or production',
];

export function globalHelp(): string {
  const commandLines = (Object.entries(HELP_ENTRIES) as [HelpCommand, CommandHelpEntry][]).map(
    ([name, entry]) => `  ${name.padEnd(16)} ${entry.summary}`,
  );

  return [
    'Usage: ontos <command> [options]',
    '',
    'Commands:',
    ...commandLines,
    '',
    'Global options:',
    ...GLOBAL_OPTIONS.map((line) => `  ${line}`),
    '',
    'Run "ontos <command> --help" for details on a specific command.',
    '',
  ].join('\n');
}

export function commandHelp(command: HelpCommand): string {
  const entry: CommandHelpEntry = HELP_ENTRIES[command];

  const options = [
    ...entry.options,
    ...(entry.remote ? REMOTE_TARGET_OPTIONS : []),
    '--json                 Emit compact JSON output',
    '-h, --help             Show help',
  ];

  return [
    `Usage: ontos ${entry.usage}`,
    '',
    entry.summary,
    '',
    'Options:',
    ...options.map((line) => `  ${line}`),
    '',
  ].join('\n');
}
