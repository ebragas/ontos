import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { ONTOLOGY_ARG } from './describeSchemas.ts';

const OBJECT_SET: JsonSchemaType = {
  description:
    'An Object Set of the Ontology HTTP API. Example: {"type":"filter","objectSet":{"type":"base","objectType":"Account"},"where":{"type":"eq","field":"phase","value":"active"}}. A Link traversal is a searchAround. A lookup by primary key is a filter on the primary key Property.',
  oneOf: [
    {
      type: 'object',
      properties: { type: { const: 'base' }, objectType: { type: 'string', description: 'The Object Type API name.' } },
      required: ['type', 'objectType'],
    },
    {
      type: 'object',
      properties: {
        type: { const: 'filter' },
        objectSet: { $ref: '#/$defs/objectSet' },
        where: {
          type: 'object',
          description:
            'A where clause of the Ontology HTTP API, such as {"type":"eq","field":"phase","value":"active"}.',
        },
      },
      required: ['type', 'objectSet', 'where'],
    },
    {
      type: 'object',
      properties: { type: { const: 'union' }, objectSets: { type: 'array', items: { $ref: '#/$defs/objectSet' } } },
      required: ['type', 'objectSets'],
    },
    {
      type: 'object',
      properties: { type: { const: 'intersect' }, objectSets: { type: 'array', items: { $ref: '#/$defs/objectSet' } } },
      required: ['type', 'objectSets'],
    },
    {
      type: 'object',
      properties: { type: { const: 'subtract' }, objectSets: { type: 'array', items: { $ref: '#/$defs/objectSet' } } },
      required: ['type', 'objectSets'],
    },
    {
      type: 'object',
      properties: {
        type: { const: 'searchAround' },
        objectSet: { $ref: '#/$defs/objectSet' },
        link: {
          type: 'string',
          description: 'The Link Type API name to traverse, from the Object Type of the Object Set.',
        },
      },
      required: ['type', 'objectSet', 'link'],
    },
    {
      type: 'object',
      properties: {
        type: { const: 'withProperties' },
        objectSet: { $ref: '#/$defs/objectSet' },
        derivedProperties: {
          type: 'object',
          description:
            'The derived properties of the request, by name, such as {"n":{"type":"selection","objectSet":{"type":"searchAround","objectSet":{"type":"methodInput"},"link":"engagements"},"operation":{"type":"count"}}}.',
        },
      },
      required: ['type', 'objectSet', 'derivedProperties'],
    },
  ],
};

const PAGE_SIZE: JsonSchemaType = { type: 'integer', description: 'The page size. 50 when absent.' };
const PAGE_TOKEN: JsonSchemaType = { type: 'string', description: 'The nextPageToken of the page before.' };

export const EXECUTE_QUERY: JsonSchemaType = {
  type: 'object',
  properties: {
    ontology: ONTOLOGY_ARG,
    query: { type: 'string', description: 'The Query Function API name.' },
    parameters: {
      type: 'object',
      description:
        'The value of each input, by its ID, such as {"plan":"plan-1","days":30}. A Query Function with no inputs takes {}.',
    },
  },
  required: ['query', 'parameters'],
};

export const APPLY_ACTION: JsonSchemaType = {
  type: 'object',
  properties: {
    ontology: ONTOLOGY_ARG,
    action: { type: 'string', description: 'The Action Type API name.' },
    parameters: {
      type: 'object',
      description:
        'The value of each parameter, by its parameter ID, such as {"objectToModifyParameter":"eng-2","status":"won"}. An Action Type with no parameters takes {}.',
    },
  },
  required: ['action', 'parameters'],
};

export const LOAD_OBJECTS: JsonSchemaType = {
  type: 'object',
  properties: {
    ontology: ONTOLOGY_ARG,
    objectSet: { $ref: '#/$defs/objectSet' },
    select: {
      type: 'array',
      items: { type: 'string' },
      description: 'The Property API names to load. Name only the Properties that you need.',
    },
    orderBy: {
      type: 'object',
      description: 'The sort order, such as {"fields":[{"field":"name","direction":"asc"}]}.',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: { field: { type: 'string' }, direction: { enum: ['asc', 'desc'] } },
            required: ['field'],
          },
        },
      },
      required: ['fields'],
    },
    pageSize: { ...PAGE_SIZE, description: 'The page size. 50 when absent, and at most 200.' },
    pageToken: PAGE_TOKEN,
  },
  required: ['objectSet'],
  $defs: { objectSet: OBJECT_SET },
};

export const AGGREGATE_OBJECTS: JsonSchemaType = {
  type: 'object',
  properties: {
    ontology: ONTOLOGY_ARG,
    objectSet: { $ref: '#/$defs/objectSet' },
    aggregation: {
      type: 'array',
      description:
        'The metrics, such as [{"type":"count","name":"count"},{"type":"sum","field":"amount","name":"total"}].',
      items: {
        type: 'object',
        properties: {
          type: {
            enum: ['count', 'sum', 'avg', 'min', 'max', 'approximateDistinct', 'exactDistinct'],
          },
          field: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['type'],
      },
    },
    groupBy: {
      type: 'array',
      description: 'The group-bys, such as [{"type":"exact","field":"phase"}].',
      items: {
        type: 'object',
        properties: { type: { enum: ['exact', 'fixedWidth', 'ranges', 'duration'] }, field: { type: 'string' } },
        required: ['type', 'field'],
      },
    },
  },
  required: ['objectSet', 'aggregation'],
  $defs: { objectSet: OBJECT_SET },
};

export const GET_EDIT_HISTORY: JsonSchemaType = {
  type: 'object',
  properties: {
    ontology: ONTOLOGY_ARG,
    objectType: { type: 'string', description: 'The Object Type API name.' },
    objectPrimaryKey: {
      type: 'object',
      description:
        'The primary key of 1 Object, by its Property API name, such as {"accountId":"acc-01"}. With none, the tool reads the history of the whole Object Type.',
    },
    filters: {
      description:
        'One filter: a timestampFilter with an optional startTime and endTime, or an operationIdsFilter with Action IDs in operationIds, such as {"type":"timestampFilter","startTime":"2026-10-20T11:00:00Z"}.',
      oneOf: [
        {
          type: 'object',
          properties: {
            type: { const: 'timestampFilter' },
            startTime: { type: 'string', description: 'A timestamp. The entries at or after it.' },
            endTime: { type: 'string', description: 'A timestamp. The entries at or before it.' },
          },
          required: ['type'],
        },
        {
          type: 'object',
          properties: {
            type: { const: 'operationIdsFilter' },
            operationIds: { type: 'array', items: { type: 'string' }, description: 'The Action IDs.' },
          },
          required: ['type', 'operationIds'],
        },
      ],
    },
    sortOrder: { enum: ['newest_first', 'oldest_first'] },
    pageSize: { ...PAGE_SIZE, description: 'The page size. 50 when absent, and at most 100.' },
    pageToken: PAGE_TOKEN,
  },
  required: ['objectType'],
};
