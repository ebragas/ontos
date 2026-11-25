export interface StubMembership {
  readonly user_id: string;
  readonly organization_id: string;
  readonly status: 'active' | 'inactive' | 'pending';
  readonly organization_name?: string;
  /** The role slugs of the membership. The default is `[STUB_ROLE]`. */
  readonly roles?: readonly string[];
}

/** How a read of the stub fails: a network error, a 500, a 429, no answer until the read is aborted, or a 200 whose body stops until then. */
export type StubFailure = 'network' | '5xx' | '429' | 'timeout' | 'stalled body';

type StubRead =
  'user' | 'membership' | 'role' | 'permissions' | 'roles' | 'organizations' | 'write' | 'application' | 'organization';

interface StubWrite {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** The permissions and the environment roles of the stub, as a test reads them. A permission with no description has `null`. */
export interface StubEnvironment {
  readonly permissions: Readonly<Record<string, string | null>>;
  readonly roles: Readonly<Record<string, readonly string[]>>;
}

/** An M2M application of WorkOS, in the shape of the REST read `GET /connect/applications/{id}`. */
export interface StubApplication {
  /** The application ID, `connect_app_...`. The default is `STUB_APPLICATION_ID`. */
  readonly id?: string;
  readonly name: string;
  readonly application_type: string;
  readonly organization_id: string;
  readonly scopes: readonly string[];
}

export interface StubWorkos {
  readonly fetch: typeof globalThis.fetch;
  /** The path and query of each request, in order. */
  readonly requests: string[];
  /** The method, the path, and the query of each request, in order, as `GET /connect/applications?organization_id=...`. */
  readonly calls: string[];
  /** The memberships. A test can change them between requests. */
  readonly memberships: StubMembership[];
  /** Sets the permissions of a role of an Organization. `undefined` deletes the role, so a read of it gets 404. */
  setRole(organization: string, slug: string, permissions: readonly string[] | undefined): void;
  /** Sets the application of a client ID. `undefined` deletes it, so a read of it gets 404. */
  setApplication(clientId: string, application: StubApplication | undefined): void;
  /** The applications now, by client ID, each with its ID. */
  applications(): Readonly<Record<string, StubApplication & { readonly id: string }>>;
  /** The client secret of an application that a `POST /connect/applications/{id}/client_secrets` made, by client ID. */
  clientSecret(clientId: string): string | undefined;
  /**
   * Makes each later read fail, or with `undefined` answer again. `reads` limits it to some reads. `retryAfter` is the
   * `Retry-After` header of a 429.
   */
  fail(
    failure: StubFailure | undefined,
    options?: { readonly reads?: readonly StubRead[]; readonly retryAfter?: string },
  ): void;
  /** Settles when the stub got `count` requests. A test waits for it before it moves the clock past a time limit. */
  reached(count: number): Promise<void>;
  /** Holds each later answer until `release` is called, and ignores each abort meanwhile. */
  hold(): void;
  release(): void;
  /** Each write that reached the stub, in order, also a write that failed. */
  readonly writes: StubWrite[];
  /** The permissions and the environment roles now. */
  environment(): StubEnvironment;
  /**
   * Lets `after` more writes pass, then fails each later write, until a call with `undefined`. `answer lost` makes the
   * write, then fails with a network error, so the caller does not know that it ran. With `count`, only that many
   * writes fail, and the writes after them pass.
   */
  failWrites(after: number | undefined, failure?: StubFailure | 'answer lost', count?: number): void;
}

export interface StubOptions {
  /** The permissions of each role, by Organization ID and role slug. The default gives `STUB_ROLE` no permission in `ORGANIZATION`. */
  readonly roles?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  /**
   * The permissions and the environment roles of the WorkOS environment. A read of a role of an Organization that `roles`
   * does not name gives the environment role. The default has none.
   */
  readonly environment?: StubEnvironment;
  /** The Organizations that the Organization list gives, after each Organization of a membership. */
  readonly organizations?: readonly string[];
  /** The applications, by client ID. The default is `SERVICE_USER` with `STUB_APPLICATION`. */
  readonly applications?: Readonly<Record<string, StubApplication>>;
  /** The names of the Organizations, by ID, for `GET /organizations/{id}`. The default names `ORGANIZATION`. */
  readonly organizationNames?: Readonly<Record<string, string>>;
  /** The client secret that each `POST /connect/applications/{id}/client_secrets` gives. The default is `stub-client-secret`. */
  readonly clientSecret?: string;
}
