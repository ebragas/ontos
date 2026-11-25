# Ontology logic runs in the Ontology service

Postgres apps often put logic in Postgres functions and enforce access with row-level security. We keep all Ontology logic in the Ontology service instead: Action rules, submission criteria, edit Functions, Object Set filters, and Object security. Postgres stores the data and enforces only primary keys, `not null`, column types, and Uniqueness constraints. OSDK does the same split: its Actions service and Object Set layer do this work, not its datastore. Logic then lives in one language, and the edit Functions are TypeScript already.

## Considered Options

- Generated PL/pgSQL functions for each Action Type and read, called by the Ontology service. This puts the logic in two languages.
- Row-level security policies generated from object security policies, with `set local role` and the user's claims in each transaction. Row-level security cannot hide one Property, so the Ontology service must still enforce property security policies.

## Consequences

- Postgres also enforces each Uniqueness constraint, as [Storage](../service/storage.md#indexes) specifies.
- A bug in the Ontology service can leak rows, because Postgres does not filter them. Only the Ontology service's database role can read the `ontology_registry`, `ontology_<n>_objects`, and `ontology_<n>_engine` schemas.
- Row-level security is on for each table, with one policy that lets the role of the Ontology service read and write all rows, as [Storage](../service/storage.md#schema-and-access) specifies. It filters no rows for a user.
- A rule-backed Action reads and generates edits with no transaction open, then writes in one short transaction. A function-backed Action reads in one snapshot transaction, so a slow edit Function holds one database connection for its run.
