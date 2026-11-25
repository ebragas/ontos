# WorkOS holds the permissions of each caller, and a service user reads and writes data

[ADR 0012](./0012-people-sign-in-with-workos-authkit-in-an-organization-and-ci-only-publishes.md) lets only a signed-in person read or write Ontology data, and the grants file gives each role its Object Types and Action Types. Two needs do not fit. A server job with no person, such as a scheduled sync job, must apply Actions. An admin of 1 Organization must change what a role can use, with no publish, and without a change for each other Organization.

So the permission becomes the one unit of access, and the configured identity provider supplies caller permissions (WorkOS in `workos` mode, JWT claims in `oidc` mode, or full local permissions in `dev` mode; see [Authentication](../service/authentication.md)). In `workos` mode, a person gets permissions through a role, and a service user gets them as the scopes of its WorkOS M2M application. The product names the permission that each type and each rule needs.

## Decision

- In `workos` mode, WorkOS issues the token of a service user. A service user is 1 WorkOS M2M application, which belongs to exactly 1 Organization. The Ontology service checks the token by JWKS and stores no secret.
- The permission is the unit of access. The grants file lists the permissions of the product, and each Object Type and Action Type names the 1 permission that it needs.
- The product owns the default roles. The grants file gives the permissions of each default role, and in `workos` mode a publish copies the permissions and the default roles to WorkOS.
- The product owns each role in v1.0: the default roles of its grants file. The Ontology service and web apps create no WorkOS custom role, so an Organization has no role of its own. A custom role created in WorkOS by hand is not supported.
- In `workos` mode, a change of access takes effect within 5 minutes for each caller. The Ontology service reads access facts from WorkOS: the membership and the role permissions of a person, and the application of a service user. It keeps each answer. An answer is fresh for 60 seconds. From 60 seconds to 5 minutes, the service reads again, and uses the kept answer only when WorkOS fails. After 5 minutes it never uses the answer.
- In `workos` mode, the Ontology service trusts no `role`, `scope`, or `permissions` claim of a token. It reads the permissions of each caller from WorkOS, so each change takes effect within 60 seconds when WorkOS answers.
- The permissions of a service user are the scopes of its M2M application. A token that asks for fewer scopes is not narrower.
- An object security policy, a property security policy, and a submission criterion name a permission, not a role.
- The Ontology service has its own permissions, with the reserved prefix `ontology:`. The first is `ontology:install`. The app decides which default role or service user holds it.
- Each caller acts in exactly 1 Organization. No service user acts for a whole app.
- The app creates each service user through its identity provider API. The Ontology service has no route for it. The app keeps each client secret, and the Ontology service stores none.
- In `workos` mode, the Ontology service copies the permissions and the default roles of a product to WorkOS. Before the transaction of a publish, the service creates each missing permission, sets its description, and adds to each default role that a stored version names each permission that the role lacks. So an added permission is early for the time of 1 publish. A default role that no stored version names gets no WorkOS addition. The reconcile after the commit creates it and gives it its permissions, so a rollback changes no such role.
- After the transaction of a publish ends, by commit or by rollback, the service makes each default role equal to the newest stored grants file, as [ADR 0015](./0015-a-publish-upgrades-every-installation-of-a-product-in-1-transaction.md) says. Every installation is on the newest version, so no installation needs a permission that the newest version dropped.
- A publish deletes no permission and no role in WorkOS. It refuses to remove a default role that a person of the WorkOS environment still has.
- The Ontology service serves the OSDK token compatibility path, `POST /multipass/api/oauth2/token`, and passes each request to WorkOS. It removes OSDK `api:` scopes, refuses each grant other than `client_credentials`, issues no token, stores nothing, and never logs the secret. So the stock `createConfidentialOauthClient` works unchanged.
- A service user is a user in the OSDK Admin user routes. Object Edit History records its client ID. `Users.get` gives it for an M2M application of the caller's Organization, with the client ID as the ID and the username. After the application is deleted, the ID gets `UserNotFound`.
- The name of a caller with no person is "service user", which is an OSDK term.
- A service user calls each route that a person calls, except the Ontology MCP route. The Ontology service adds no rate limit. The request log and the trace of each request record the caller kind.
- When the Ontology service must read permissions from WorkOS and WorkOS does not answer, the request fails with an error that tells the caller to retry. The Ontology service never uses access that is more than 5 minutes old.
- A staging reset copies no service user. Automated tests that verify a service user create and delete their own test service user per run so no secret is stored.
- Ontos v1.0 accepts only permission-based grants files and does not read legacy role lists.
- A caller can see and apply an Action Type only when it holds the permission of the Action Type and the permission of each Object Type that the Action Type names. The Ontology service checks this at each request. Publish checks it for each default role.
- An Action parameter that takes a user accepts a service user of the Organization. The route that lists the Organizations of a person gives a service user its 1 Organization.
- In `workos` mode, the AuthKit domain is a required setting of each deployment, and a separate setting turns the Ontology MCP on. Each environment holds both keys, so the MCP state is always explicit.
- The Ontology service serves a permission catalog for the role screen of a web app: each permission of the installed product, its description from the grants file, and the permissions that it requires. The Ontology service computes the required permissions at each publish. The catalog also lists the permissions of the service.

## Considered Options

- The Ontology service issues the machine token. It controls the lifetime and the claims, but it becomes an OAuth server with signing keys and stored secrets.
- The Ontology service keeps a record of each service user with its role. A person's access would be in WorkOS and a machine's access in the service: 2 stores for 1 fact.
- The role stays the unit, and a scope of the M2M application names 1 role. It is the smallest change, but an Organization cannot change what a role can use, and a publish changes each Organization.
- The Ontology service makes 1 permission for each type. An admin of an Organization would decide on each new type.
- The Ontology service tracks the changes that an Organization makes to a default role, and applies them again after each publish. A new permission would then reach a role that an Organization chose to restrict.
- A default role takes its permissions from the grants file of the installed version, and WorkOS holds a copy. No publish order could then take access away early. We rejected this option because permissions must have 1 store.
- A service user keeps its access for the 1 hour that its token lasts. A deleted M2M application or a leaked secret would keep access for up to 1 hour.

## Consequences

- A WorkOS M2M token carries `org_id` and `scope`, has no role, has `aud` as a string, and lasts 3,600 seconds. A deleted secret or application does not end a token that WorkOS already issued.
- In `workos` mode, the Ontology service depends on WorkOS at request time for each caller that reads or writes data. When WorkOS does not answer, and the kept answer is older than 5 minutes, the request fails.
- In `workos` mode, WorkOS holds 1 list for each default role, for every Organization. Between the WorkOS additions of a publish and its reconcile, a member can hold a permission that the stored version does not give the role. When the publish stops, or its reconcile fails, in that time, the permission can stay until a later publish runs its reconcile.
- Each instance of the service keeps its own WorkOS answers. During a WorkOS failure, 1 instance can allow a request for up to 5 minutes that another instance already refuses.
- To end the access of a service user with a leaked secret, delete its application in WorkOS.
- A `groupProperty` policy compares the caller with values that Objects store. An app that stores role slugs there must store permission slugs instead.
- Grants files, policies, and submission criteria name permissions rather than roles.
