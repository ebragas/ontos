# Ontology

The Ontology maps data into objects, properties, and links: its semantic elements. It changes that data through action types and functions: its kinetic elements (OSDK: Ontology overview). This tree specifies each Ontology concept that the Ontology service provides, with one file per concept. [`docs/service/`](../service/) specifies how the Ontology service delivers these concepts.

## Purpose of each doc

Each doc answers one question. Content that does not answer its doc's question goes elsewhere.

| Doc                                             | Answers                                                                                           | Holds no                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [`README.md`](../../README.md)                  | What is Ontos, and how do I run the 5-minute quickstart?                                          | Deep concept rules                                 |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md)      | How do I develop, lint, test, and contribute to this repository?                                  | Ontology concept rules                             |
| [`docs/linting.md`](../linting.md)              | Which static checks, `Fallible` rules, and `@interfere/landmines` rules run in CI?                | Ontology concept rules                             |
| [`design-rules.md`](./design-rules.md)          | How should an Ontology be modeled, and how do we decide a service feature?                        | Engine mechanics                                   |
| Concept files in this tree                      | What does the Ontology service do? Each file states one concept's contract and guarantees.        | Rationale, history, or how-to                      |
| Files in [`docs/service/`](../service/)         | How does the Ontology service deliver the concepts? Each file states one service part's contract. | Rationale, history, or how-to                      |
| [`out-of-scope.md`](../service/out-of-scope.md) | What does the Ontology service leave out?                                                         | Rules. It links to the file that states each rule. |
| [`deviations.md`](../service/deviations.md)     | What does the Ontology service do differently from upstream OSDK defaults, on purpose?            | Rules. It links to the file that states each rule. |
| [`deployment.md`](../service/deployment.md)     | How do I deploy and configure an Ontology service deployment?                                     | Ontology concept rules                             |
| [`GLOSSARY.md`](../../GLOSSARY.md)              | What does this term mean?                                                                         | Rules or behavior                                  |

## Tree

- This tree mirrors the sections of the OSDK Ontology docs. Each folder takes the name of an OSDK doc section, such as `action-types/` for Action Types.
- Each file holds one concept that has its own OSDK overview page. An OSDK sub-feature of that concept, such as an Object Type's statuses, is a section in the concept file. Give a sub-feature its own file only when the concept file grows too long to read.
- Give an OSDK section a folder only when it holds 2 or more files. Otherwise, put its one file at the root of this tree.
- Put a service part that has no OSDK Ontology concept, such as storage or Ontology service deployments, in [`docs/service/`](../service/).

## Scope

- An OSDK concept is in scope when Ontos apps need it, or when the stock `@osdk/client` or `@osdk/maker` requires it.
- Each concept file lists the OSDK features that the Ontology service leaves out, under "Out of scope". A feature out of scope is not a deviation.
- [Ontology-as-code](../service/ontology-as-code.md) specifies how the Ontology service refuses a feature out of scope.

## Frontmatter

Each concept file and each service file starts with YAML frontmatter:

```yaml
---
status: specified
---
```

- `status` is `not-specified` or `specified`. `not-specified` marks an open design gap. `specified` means the file states the contract.
- To find the change behind a rule, read the file's Git history.

To list every open gap, run `grep -rl "^status: not-specified" docs/`.

## Placeholders

- A placeholder is a file with `status: not-specified`, its frontmatter, and its title. It marks a concept or service part that still needs design.
- Add a placeholder for each open decision, even when a feature may stay out of scope.
- When a pull request specifies the file, set `status: specified` in the same pull request. When a concept is ruled out of scope, delete the file.

## Concept file template

```markdown
---
status: specified
---

# <Concept name, in the OSDK term>

<One- or two-sentence definition.> Source: [<page title>](URL).

## Contract

- <One rule or guarantee.> Source: [<page title>](URL).
- <A rule with no OSDK source.> Our rule.
- <A rule that departs from OSDK.> Deviation: OSDK does X. We do Y because Z.

## Diagram

<A Mermaid diagram. Include this section only when the concept has relationships or a flow to show.>

## Out of scope

- <Feature>: <one line>. Source: [<page title>](URL).

## Related

- [<Concept>](<relative path>)
```

- Write one rule per list item. End each rule with its source, "Our rule.", or its deviation, in the form that [`design-rules.md`](./design-rules.md) uses.
- Keep rationale and history out of concept files. Record a hard-to-reverse decision and its reason in an ADR under `docs/adr/`.
- A service file uses the same template with three changes: it omits the `osdk` field, it omits "OSDK features out of scope", and it adds a "Serves" section that links to the concept files it delivers.
