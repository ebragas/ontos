import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import { CliError } from '../cliError.ts';
import type { Fallible } from '../fallible.ts';
import { findLinkType } from './linkType.ts';

export function* describeOntology(
  metadata: OntologyFullMetadata,
  name: string | undefined,
  productRid: string,
): Fallible<unknown, CliError> {
  const objectTypes = Object.values(metadata.objectTypes);
  const actionTypes = Object.values(metadata.actionTypes);

  const linkTypes = objectTypes.flatMap(({ objectType, linkTypes }) =>
    linkTypes.map((link) => ({
      objectType: objectType.apiName,
      apiName: link.apiName,
      displayName: link.displayName,
      target: link.objectTypeApiName,
      cardinality: link.cardinality,
      linkTypeRid: link.linkTypeRid,
    })),
  );

  if (name === undefined) {
    return {
      objectTypes: objectTypes.map(({ objectType: { apiName, displayName, description } }) => ({
        apiName,
        displayName,
        description,
      })),
      linkTypes,
      actionTypes: actionTypes.map(({ apiName, displayName, description }) => ({ apiName, displayName, description })),
    };
  }

  const object = metadata.objectTypes[name];

  if (object) {
    const { apiName, displayName, pluralDisplayName, description, primaryKey, titleProperty, properties } =
      object.objectType;

    return {
      objectType: {
        apiName,
        displayName,
        pluralDisplayName,
        description,
        primaryKey,
        titleProperty,
        properties: Object.fromEntries(
          Object.entries(properties).map(([property, { displayName, description, dataType }]) => [
            property,
            { displayName, description, dataType },
          ]),
        ),
        links: linkTypes.filter((link) => link.objectType === apiName),
      },
    };
  }

  const action = metadata.actionTypes[name];

  if (action) {
    const { apiName, displayName, description, parameters } = action;

    return { actionType: { apiName, displayName, description, parameters } };
  }

  const links = linkTypes.filter((link) => link.apiName === name);

  if (links.length > 0) return { linkTypes: links };

  const linkType = findLinkType(productRid, name, linkTypes);

  if (linkType) return { linkType };

  return yield new CliError(`No Object Type, Link Type, or Action Type has the API name ${name}.`);
}
