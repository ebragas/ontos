# Glossary

The terms of the Ontology service. Each term uses the OSDK name for the concept and cites the OSDK page that defines it. A term with no OSDK page says "Our term."

## Language

### Apps

**App**:
One application offering: its product, its Ontology deployment repository, its Ontology service deployment with its identity provider configuration, and its consumers. Many Organizations can use 1 app. Our term.
_Avoid_: project, tenant, workspace

**Ontology Service repository**:
The repository that holds the code of the Ontology service, and makes each release: `ebragas/ontos`. Our term.
_Avoid_: service repository, "this repo" (outside this repository)

**Ontology deployment repository**:
The repository of one app's Ontology service deployment, such as `example-ontology`. It holds the app's Ontology-as-code and its deployment file, and it deploys, publishes, and makes the app's Ontology SDK. Our term.
_Avoid_: app repository, Ontology repository, deployment repo

**Consumer**:
Software that calls an Ontology service deployment through the Ontology SDK or the CLI, and does not hold its Ontology, such as a web app. A consumer can call more than 1 app. Our term.
_Avoid_: client, frontend, downstream app

**Consumer repository**:
The repository of one consumer. Our term.

**Web app**:
The consumer that people use in a browser. It signs people in, and its server code calls an Ontology service deployment through the Ontology SDK. Our term.
_Avoid_: frontend, client, site

**Web app repository**:
The consumer repository of a web app, such as `example-web-app`. Our term.

**Organization**:
One company or group that uses an app, and the boundary of its data. It maps to 1 Organization in the configured identity provider (such as a WorkOS Organization, OIDC tenant, or local `dev` organization), and it owns 0 or more Ontologies. A person can be a member of many Organizations, with 1 role in each. A service user belongs to exactly 1 Organization. Source: Organizations and spaces ("Organizations are strict access requirements that strongly protect your organization’s data").
_Avoid_: customer, tenant, account, workspace

**Mirror Organization**:
An Organization in a staging identity provider environment whose `external_id` is the ID of 1 production Organization. After a staging reset, the remap gives it the staging copies of the installations of that production Organization, so that its members can test them. Our term.
_Avoid_: copy Organization, shadow Organization, mirror (alone)

**Stock client**:
The unchanged `@osdk/client` package, which apps use with the Ontology SDK on the Ontology service. Source: `@osdk/client`.
_Avoid_: client (alone), SDK client

### Authoring

**Ontology-as-code**:
The definition of an app's Ontology as TypeScript calls to the `define*` functions of `@osdk/maker`, which act as the source of truth for its entities. Source: SuperRepo core concepts.
_Avoid_: schema file, Ontology config

**Ontology metadata**:
The JSON description of every Object Type, Link Type, and Action Type in an app's Ontology, in the shape of OSDK `OntologyFullMetadata`. The Ontology service makes it from the IR. Our term. Source of the shape: `@osdk/vite-plugin-oac` README.
_Avoid_: contract, schema JSON, manifest

**IR**:
The `OntologyIr` JSON that `@osdk/maker` writes from an app's Ontology-as-code, which the app publishes. Source: `@osdk/maker` CLI.
_Avoid_: ontology.json, block data, compiled Ontology

**API name**:
The name that code uses for an Ontology entity. For an Object Type or an Action Type, it is the fully qualified API name, with the API namespace in front, such as `com.example.crm.Account`. Source: Marketplace installation ("Fully qualified API names include a namespace prefix").
_Avoid_: ID, key, machine name

**API namespace**:
The prefix, such as `com.example.crm.`, that `@osdk/maker` puts in front of each Object Type and Action Type API name. The app sets it as `apiNamespace` in `ontos.yml` (or `foundry.yml`). Source: SuperRepo core concepts.
_Avoid_: prefix, package name

**Product**:
A versioned Ontology definition with no data: its IR, its schema migrations, its Functions, and its OSDK set. CI publishes it from the Ontology-as-code of an Ontology deployment repository. Its API name is the app name, and its product RID is the namespace of each RID that the Ontology service derives for it, so each installation has the same Object Type and Action Type RIDs. Source: Product delivery.
_Avoid_: template, base Ontology, package

**Product version**:
The number of one published version of a product in one environment, counted 1, 2, 3. Our term.
_Avoid_: schema version, revision

**Ontology version**:
The product version that one Ontology runs. Our term.
_Avoid_: schema version, revision

**Installation**:
One Ontology made from one product, with its own Ontology RID, its own data, and exactly 1 owner Organization. Source: Product delivery ("Install your product for each ecosystem participant").
_Avoid_: instance, tenant, copy

**Install**:
To make a new, empty Ontology from a product for the caller's Organization. Source: Product delivery.
_Avoid_: create, provision, deploy

**Publish**:
To send a new version of a product to one environment of its Ontology service deployment. The Ontology service stores it and upgrades every installation of the product to it in 1 transaction, or changes nothing. Our term.
_Avoid_: deploy, migrate

**Upgrade**:
To move 1 installation from its version to the newest version of its product, by 1 step for each version in order. A publish upgrades every installation in its transaction, and a restore upgrades the restored installation in its switch. Our term.
_Avoid_: migrate, roll out, converge

**OSDK set**:
One exact version each of `@osdk/maker`, `@osdk/maker-experimental`, `@osdk/client`, `@osdk/cli`, and `@osdk/functions` that CI tests together, and that an app pins. Our term.
_Avoid_: OSDK version, toolchain

**Schema migration**:
An instruction that says what to do with stored values when a change to the Ontology would break them, such as Drop or Move. Source: Manage schema changes.
_Avoid_: migration script, DDL

**Permission**:
The unit of access. A caller that holds a permission can use each Object Type, Action Type, and rule that names it. A person holds the permissions of their role, and a service user holds its own. Source: [Roles and permissions](https://workos.com/docs/authkit/roles-and-permissions) ("Permissions grant users privileged access to resources and actions in your application").
_Avoid_: Role grant, scope, ACL, edit grant

**Default role**:
A role that a product defines in its grants file, with its permissions. It is the same in each Organization. Our term.
_Avoid_: environment role, built-in role, system role

**Custom role**:
A role that 1 Organization owns, with its own permissions. Source: [Custom roles](https://workos.com/docs/rbac/custom-roles) ("Custom roles are roles scoped to a particular organization").
_Avoid_: organization role, role override

**Service user**:
A caller with no person, such as a sync job. It belongs to exactly 1 Organization and holds permissions directly, with no role. Source: Developer Console permissions ("Your application will use a generated service user for permissions rather than applying user permissions").
_Avoid_: machine caller, machine user, robot, bot, service account

**Grants file**:
The file `src/grants.json` of an app's Ontology-as-code, which holds the permissions of the product, the permission that each type needs, and its default roles. Our term.
_Avoid_: permissions file, roles file

**Object security policy**:
The condition on an Object Type that decides which of its Objects a person can view. Source: Object security policies.
_Avoid_: row filter, row-level security policy

**Property security policy**:
The condition on 1 or more Properties of an Object Type that decides whether a person can view their values. A person who fails it reads null. Source: Object security policies.
_Avoid_: column mask, property security group

**Person attribute**:
A set of primary keys that the Ontology service derives for a person from Objects, for use in a policy, such as the jobsites of a crew member. Our term.
_Avoid_: user attribute, claim

### Request time

**Ontology SDK**:
The typed code that the OSDK generator writes from an app's Ontology metadata, which app code uses with the stock `@osdk/client` to read Objects and apply Actions. Source: Ontology SDK overview.
_Avoid_: client, generated client, OSDK (except when it names the OSDK product)

**Ontology SDK package**:
The npm package of one app's Ontology SDK, which its consumers pin. Our term.
_Avoid_: SDK release, generated package

### Service

**Ontology service**:
The Ontos service that serves the OSDK HTTP API v2 and Ontology MCP for the Ontologies of one app. Our term.
_Avoid_: backend, engine, server, runtime, runtime library, framework

**Ontology service deployment**:
The Ontology service for one app, with its own PostgreSQL 17 database, hosted on Docker, Node.js, or Vercel. An app can run separate environments such as staging and production, each on 1 pinned release. Our term.
_Avoid_: Deployment (alone), instance, tenant. In these docs, a lowercase "deployment" is one runtime build or container instance.

**Environment**:
One isolated runtime stage of an Ontology service deployment, such as local, staging, or production. Each environment has its own host (Docker, Node.js, or Vercel), PostgreSQL 17 database, identity provider configuration (`dev`, `oidc`, or `workos`), and base URL. Our term.
_Avoid_: stage, tier. Name the specific platform environment when needed: Vercel environment, WorkOS environment, GitHub environment.

**Ontology MCP**:
The MCP server of the Ontology service, at the base URL of an environment plus `/api/mcp`. An agent in Claude, ChatGPT, or Grok reads Objects and applies Actions through it, as the person who signed in. Our term.
_Avoid_: MCP (alone), agent API

**Business map**:
The answer of `describe_object_type` with no name in the Ontology MCP: each Object Type with its Link Types and the Action Types that change it, with their descriptions. Our term.
_Avoid_: schema, Ontology map

**Worker**:
A Node.js worker thread of the Ontology service that runs one Function call at a time. Source: [Worker threads](https://nodejs.org/api/worker_threads.html).
_Avoid_: sandbox, runner, Function instance

**Ontology RID**:
The identifier of one Ontology, which install makes. The Ontology SDK gets it at runtime from List Ontologies. Source: Resource identifiers.
_Avoid_: Ontology ID, ontology name

**Compiled Ontology**:
The typed form of one Ontology version that the Ontology service makes from its IR in memory, and that its routes read in place of the IR. Our term.
_Avoid_: runtime IR, schema cache

**Release**:
One version of the Ontology service code, named by a Git tag `vX.Y.Z` of this repo, and its 2 packages of that version: the CLI and the service package. Our term.
_Avoid_: image, build, service version

**Pre-release**:
A release with a tag `vX.Y.Z-rc.N`. An app runs a pre-release only when it opts in. Our term.
_Avoid_: beta, canary, nightly

**Conformance test**:
A test that sends requests through the stock `@osdk/client` and a generated Ontology SDK to the Ontology service, and checks each answer against the OSDK HTTP API v2 specification and Ontos rules. Our term.
_Avoid_: integration test, end-to-end test, contract test

**MCP test**:
A test that calls the Ontology MCP through the stock MCP TypeScript SDK client, against the service from `node.ts` on the test Postgres container. Our term.
_Avoid_: MCP conformance test, MCP integration test

**Smoke test**:
A test that runs against one environment after it deploys a release there, and that reads but never changes app data. Our term.
_Avoid_: health check, canary

**Pull request check**:
The CI job in an app's Ontology deployment repository that checks each pull request with a `validateOnly` publish to the target environment. Our term.
_Avoid_: PR build, preview check

**Twin**:
The self-contained reference test Ontology-as-code, compiled IRs, seed data, and Functions in `packages/service/twin/` used to test the Ontology service end to end. Our term. A Mirror Organization is a staging Organization, so "mirror" alone never names a Twin.
_Avoid_: mirror, replica, shadow

**Deployment file**:
The file in an Ontology deployment repository that holds the settings of its Ontology service deployment that are not secret. It pins no release. Our term.
_Avoid_: manifest, inventory, config

**Managed file**:
A file in an Ontology deployment repository that the CLI writes, with the same content in each app for the same release, and that the app does not change. Our term.
_Avoid_: template, boilerplate, generated file

**Seeded file**:
A file in an Ontology deployment repository that holds the app's values, that initialization writes once, and that the app then owns. Our term.
_Avoid_: template, starter file, scaffold

**Identity provider**:
The service or local adapter that authenticates callers and issues tokens, configured in `dev`, `oidc`, or `workos` mode. Source: Authentication overview.
_Avoid_: auth provider, IdP, user store

**User ID**:
The `sub` claim of a caller's token, which identifies one person, one service user, or one CI workflow. For a person, it is the user ID from the identity provider. For a service user, it is its client ID. Our term.
_Avoid_: account ID, user key

**Trace**:
The record of 1 request to the Ontology service: 1 root span and its child spans, with 1 trace ID. Source: [Traces](https://opentelemetry.io/docs/concepts/signals/traces/).
_Avoid_: request log, profile

**Span**:
1 timed step of a trace, with a name, a start and end time, a parent, and attributes. Source: [Traces](https://opentelemetry.io/docs/concepts/signals/traces/).
_Avoid_: event, timing, segment

**Span catalog**:
The one list of the span names of the Ontology service, with the attributes and the required child spans of each. Our term.
_Avoid_: span registry, span list

**Request log**:
The one JSON log line that the Ontology service writes for each request, with the Ontology and caller fields that standard HTTP access logs do not record. Source: Instrumentation and telemetry.
_Avoid_: access log, audit log, trace

### Ontology types

**Object Type**:
The schema definition of a real-world entity or event. Source: Object types overview.
_Avoid_: model, entity, table, resource

**Object**:
One instance of an Object Type. Source: Object types overview.
_Avoid_: record, row, entity

**Property**:
The schema definition of one characteristic of an Object Type. Source: Properties overview.
_Avoid_: field, column, attribute

**Type class**:
A label with a kind and a name on a Property, Link Type, or Action Type, which OSDK apps read to change how they show or index it. Source: Type classes.
_Avoid_: tag, annotation

**Searchable**:
The setting of a Property that gives it a text search index, so that text search queries can use it. Source: Render hints.
_Avoid_: filterable, sortable

**Primary key**:
The Property whose value identifies each Object of an Object Type. Source: Create an object type.
_Avoid_: ID column, object ID

**Title key**:
The Property whose value names an Object for display. Source: Create an object type.
_Avoid_: label field, display field

**Base type**:
The kind of value that a Property holds, such as String, Decimal, or Timestamp. Source: Base types.
_Avoid_: data type, field type, column type

**Value type**:
A named base type with constraints, such as a fixed list of values or a regex, that one or more Properties use, so that each value of those Properties must pass the constraints. Source: Value types.
_Avoid_: enum type, custom type, validation rule

**Derived property**:
A read-only Property whose value the Ontology service computes at read time from linked Objects: link hops, then 1 aggregation or 1 linked value, and in a request also filters and arithmetic. An Object Type declares it, or a request declares it with `withProperties`. Source: Derived properties ("properties whose values are calculated at query time from other properties or from linked objects").
_Avoid_: computed field, calculated column, virtual property, rollup

**Uniqueness constraint**:
A named rule on an Object Type that no 2 of its Objects have the same value in 1 Property, or the same values in a set of Properties. An Object with no value in one of those Properties never clashes. It is separate from the primary key. Our term.
_Avoid_: unique key, secondary key, alternate key, unique index

**Struct**:
A base type that holds several named fields in one Property, each with its own base type, such as an address with a street and a city. Source: Structs.
_Avoid_: object property, nested object, record

**Link Type**:
The schema definition of a relationship between two Object Types. Source: Link types.
_Avoid_: relation, association, reference

**Link**:
One instance of a Link Type between two Objects. Source: Link types.
_Avoid_: edge, relation

**Status**:
The lifecycle state of an Object Type, Property, or Link Type: `experimental`, `active`, or `deprecated`. Source: Statuses.
_Avoid_: lifecycle, stage

**Object Set**:
A set of Objects of one Object Type, made from a base Object Type with filters, set operations, and Link traversals, which app code reads or aggregates. Source: Object sets.
_Avoid_: query, collection, result set

**Analyzer**:
The setting of a String Property that decides how text search reads its value, such as whether it splits the value into words and ignores case. Source: Type classes (the `analyzer` kind).
_Avoid_: tokenizer, text index

**Action Type**:
The definition of a set of edits to Objects, property values, and Links that a user applies at once. Source: Action types overview.
_Avoid_: command, mutation, operation

**Action**:
One application of an Action Type, which applies its edits in a single transaction. Source: Action types overview.
_Avoid_: request, write, update

**Rule**:
One step of an Action Type that defines edits, such as Create object or Function. Source: Rules.
_Avoid_: logic, step, handler

**Rule-backed Action**:
An Action whose Action Type defines its edits with rules other than a Function rule. Our term, from Rules.
_Avoid_: simple Action, declarative Action

**Function-backed Action**:
An Action whose Action Type has one Function rule, so that a Function returns its edits. Source: Function-backed actions.
_Avoid_: custom Action, code Action

**Object parameter**:
An Action parameter whose value is one Object of a named Object Type. Source: Action parameters.
_Avoid_: object reference, object ID parameter

**Default value**:
The value that an Action uses for a parameter that the call leaves out, such as a Property of the Object in an Object parameter. Sources: Set parameter default value ("Parameters can be set to default values to display either a fixed value or a property of the selected object") and the parameter setting `defaultValue` of `@osdk/maker`.
_Avoid_: prefill

**Submission criteria**:
The conditions that must all pass before an Action can be submitted. Source: Submission criteria.
_Avoid_: guard, precondition, validation rule

**Function**:
TypeScript code that an app writes. It reads Objects, and it returns edits or a value. Source: Getting started with TypeScript v2.
_Avoid_: handler, script, Edge Function, Vercel Function (a Vercel Function is the unit that Vercel runs)

**Edit Function**:
A Function that returns edits to Objects and Links, which a function-backed Action applies. Source: Ontology edits overview.
_Avoid_: mutation Function, write Function

**Query Function**:
A Function that returns a value and makes no edits. An app runs it through the Execute Query route. Source: Query functions ("Queries are the read-only subsets of functions").
_Avoid_: read Function, compute Function, query (alone)

**Function bundle**:
The one JavaScript module that the CLI makes from all Functions of an app, with the packages that they import and the app's own `@osdk/client`. Our term.
_Avoid_: Function package, Function build

**Provenance**:
The Object Types and Link Types that a function-backed Action may edit, from the `Edits` type of its Function. Source: Function-backed actions: getting started.
_Avoid_: edit scope, permissions

### Data

**Join table**:
The table that backs a many-to-many Link Type, with one column for the primary key of each side. Source: Create a link type.
_Avoid_: link table, junction table

**Object Edit History**:
The record of each create, modify, and delete of an Object that an Action applies, kept for each Object Type that turns it on. Source: Enable user edit history.
_Avoid_: audit log, changelog

**Engine change**:
A change that a release makes to the database, as opposed to the changes that a publish makes from an Ontology. Our term.
_Avoid_: migration (alone), DDL

**Object version**:
A counter on each Object that changes on each edit, used to detect that an Object changed while an Action generated its edits. Source: How user edits are applied.
_Avoid_: revision, row version, etag
