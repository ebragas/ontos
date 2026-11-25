import { CliError, errorBody } from './cliError.ts';
import { failureOf } from './errors.ts';
import { attempt, type AsyncFallible } from './fallible.ts';
import type { Io } from './io.ts';

const HEAD_CHECK_VARIABLES = [
  'GITHUB_SHA',
  'GITHUB_REF_NAME',
  'GITHUB_REPOSITORY',
  'GITHUB_API_URL',
  'NODE_AUTH_TOKEN',
] as const;

const REFUSED = { publish: 'publishes', deploy: 'deploys' } as const;

export async function* checkBranchHead(io: Io, job: keyof typeof REFUSED): AsyncFallible<void, CliError> {
  if (io.env['GITHUB_ACTIONS'] !== 'true') return;

  const missing = HEAD_CHECK_VARIABLES.filter((name) => !io.env[name]);

  if (missing.length > 0)
    return yield new CliError(
      `The ${job} job needs ${missing.join(', ')} to check that its commit is the head of its branch.`,
    );

  const {
    GITHUB_SHA: commit,
    GITHUB_REF_NAME: branch,
    GITHUB_REPOSITORY: repository,
    GITHUB_API_URL: api,
    NODE_AUTH_TOKEN: token,
  } = io.env as Readonly<Record<(typeof HEAD_CHECK_VARIABLES)[number], string>>;

  const response = yield* attempt(
    () =>
      io.fetch(`${api}/repos/${repository}/git/ref/heads/${branch}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      }),
    failureOf,
  );

  if (response.status !== 200) {
    const message = `GitHub gave ${response.status} for the head of the branch ${branch}.`;

    return yield new CliError(message, { message, github: yield* errorBody(response) });
  }

  const head = ((yield* attempt(() => response.json(), failureOf)) as { object?: { sha?: unknown } }).object?.sha;

  if (typeof head !== 'string')
    return yield new CliError(`GitHub gave no commit for the head of the branch ${branch}.`);

  if (head !== commit)
    return yield new CliError(
      `The commit ${commit} is not the head of the branch ${branch}, which is ${head}. A re-run of an older commit ${REFUSED[job]} nothing.`,
    );
}
