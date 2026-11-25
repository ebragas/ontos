import type { JsonSchemaType } from '@modelcontextprotocol/server';

export const ONTOLOGY_ARG: JsonSchemaType = {
  type: 'string',
  description:
    'The API name of an Ontology of your Organization. Needed when your Organization has more than 1 Ontology.',
};

export const DESCRIBE_OBJECT_TYPE: JsonSchemaType = {
  type: 'object',
  properties: {
    ontology: {
      type: 'string',
      description:
        'The API name of an Ontology of your Organization. With no objectType and no ontology, the tool lists the Ontologies when your Organization has more than 1.',
    },
    objectType: {
      type: 'string',
      description: 'The Object Type API name. With none, the tool gives the business map.',
    },
  },
};

export const DESCRIBE_ACTION: JsonSchemaType = {
  type: 'object',
  properties: {
    ontology: ONTOLOGY_ARG,
    actionType: {
      type: 'string',
      description: 'The Action Type API name. With none, the tool lists each Action Type.',
    },
  },
};

export const DESCRIBE_QUERY: JsonSchemaType = {
  type: 'object',
  properties: {
    ontology: ONTOLOGY_ARG,
    query: {
      type: 'string',
      description: 'The Query Function API name. With none, the tool lists each Query Function.',
    },
  },
};
