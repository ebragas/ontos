# A publish upgrades every installation of a product in 1 transaction

Before this decision, a publish stored a product version, and each installation then upgraded alone. An operator could hold 1 installation on its version. So installations of 1 product could run different versions, and each rule had to say what a held installation and a behind installation get. Those rules caused defects: a held installation kept a dropped permission on a default role for every Organization.

To eliminate version skew across installations of 1 product, the service now keeps one rule: every installation of a product is on the newest product version. A publish upgrades all of them and stores the version in 1 Postgres transaction, or it changes nothing.

[The publish model](../service/diagrams/publish-model.html) draws the states of this design and gives the rules that a model check proved.

## Decision

- A publish that applies runs 5 steps in order: the check, the WorkOS additions, the transaction, the WorkOS reconcile, and the answer.
- The check reads and locks nothing that a request waits for. It plans the new version against the data of each installation. A `validateOnly` publish stops after the check. The check and the transaction give the same error for the same data.
- The transaction sets `lock_timeout` to 5 seconds and `transaction_timeout` to 60 seconds, 1 time. It locks the product versions. It refuses with 409 when the newest version changed since the check, and the CLI tries again. It locks each registry row in installation number order, 1 row for each statement, so a lock wait names its installation. It inserts the new product version. It runs 1 step on each installation. Then it commits.
- A failure in the transaction rolls back all of it. No version is stored, and no installation moves. The error names the installation and the change, and gives the duration of the transaction.
- Each actor takes locks in 1 order: the product versions, then registry rows by number, then tables by name.
- An installation that is not on the newest version at the start of the transaction is a fault. The publish stops with a 500 error that names it. The publish does not repair it.
- One module owns each write of a version: the insert of a product version, the move of each installation, the registry row of an install, and the switch of a restore. SQL derives the version in each write, and no function takes a version number. A lock value that only that module makes is an argument of each write.
- After the transaction ends, by commit or by rollback, the service reads WorkOS again and makes the default roles equal to the newest stored grants file. It adds each permission that a role lacks, and removes each permission that the file does not give the role. Only the newest grants file decides the permissions. The role names of each stored version tell the service which removed default role to empty.
- The publish jobs of 1 environment run 1 at a time, as [Managed files](../service/deployment.md#managed-files) specifies, and only CI publishes. The design depends on this rule. The service has no lock of its own for a whole publish, and the publish job makes no check before it releases the Ontology SDK package.
- When the reconcile fails after a commit, the publish answers 503 and says that the version is stored and that WorkOS is not reconciled. The publish job exits 1, and it releases no Ontology SDK package.
- A rerun of the publish job is the repair for each failure after a commit. It stores no new version, runs the reconcile again, and releases the Ontology SDK package of the newest version.
- A restore of 1 installation locks its registry row and reads the newest version. It runs the chain of stored steps on the copied schemas, from the version of the copy to the newest version. Then it switches the row. When a step fails, the restore fails and the row does not switch.
- Publish and restore share 1 chain. In a publish the chain has 1 step. Only a restore runs more than 1 step.
- An install takes the lock of the product versions, so it waits for an open publish, and then installs at the newest version.
- The publish answer and the request log give the duration of the transaction. The design is reviewed again when a production publish takes more than 30 seconds, or when a publish fails on the data of 1 installation and a changed schema migrations file cannot solve it.
- When the data of 1 installation blocks a publish, a person has 3 options: publish a changed schema migrations file, ask an admin of that Organization to fix the data, or restore that installation.
- The service has no hold, no behind state, no upgrade route, and no upgrade pass in the CLI. The errors `OntologyService:InstallationBehind` and `OntologyService:PermissionInUse` do not exist.
- The column `held` of the registry stays in the database, and no code reads it, because an engine change only adds.
- The cold-start check compiles the newest version of each installed product. An earlier release can serve an environment only when it supports that version.
- This single-transaction publish design is the standard behavior in Ontos v1.0.

## Considered Options

- Keep the hold. Each rule about permissions, the cold start, and a release rollback then keeps a case for a held installation, for a failure that did not occur.
- Remove the hold, and keep the upgrade of each installation after the store. A failure after the store then leaves an installation behind, and every later publish is refused until an admin of that Organization fixes its data. A changed schema migrations file cannot help, because the stored step runs first.
- A dry run of each upgrade before the store. It finds no failure that the check does not find, it cannot predict a write between the dry run and the upgrade, and it takes each table lock 2 times.
- A restore that leaves the installation on the version of its copy. Installations of 1 product then run different versions again, and the app of that product calls an older Ontology for 1 Organization.
- A database trigger that refuses a commit with an installation below the newest version. An engine change adds only a table, a column, an index, or the `pg_trgm` extension, and it is permanent.
- One step function with a loop in publish and a loop in restore, and no chain. Each loop then repeats the same handling of a failure, and 2 paths upgrade an installation.
- The WorkOS additions after the commit. A WorkOS failure then can hide each new type from every Organization until a rerun. The design takes this cost only for a default role that no stored version names, as [ADR 0014](./0014-workos-holds-the-permissions-of-each-caller-and-a-service-user-reads-and-writes-data.md) says, so that a rollback changes no such role.
- A lock that the service holds for a whole publish request, and a check of the newest version before the Ontology SDK package. Both protect against 2 publishes at one time, which the queue already prevents. The cases that stay are rare, lose no data, and end with a rerun of the job.
- A read of the stored versions after a commit whose answer is lost. A rerun of the job gives the same result.

## Consequences

- The data of 1 installation can block the publish of a product for every Organization.
- Each changed table of each installation stays locked until 1 commit. The 60 seconds cover all installations together.
- The lock of the product versions covers the whole table. One Ontology service deployment serves one product, so the lock blocks no other product. A deployment that serves more than one product needs a lock for each product.
- Two publishes of 1 environment at one time can leave a default role without a permission that the newest version gives it, or release the Ontology SDK package of an older version. The queue prevents this, except when a job is canceled while its request still runs and the next job starts. A change that lets another caller publish, or that removes the queue, must add a lock in the service first.
- A publish job can exit 1 for a version that is stored: when the reconcile fails after the commit, or when the answer of the commit is lost.
- No case above loses data, and a rerun of the publish job repairs each one.
- An error names only the first installation that fails.
- A staging reset fails when 1 copied installation cannot upgrade. The same data blocks the same publish in production.
