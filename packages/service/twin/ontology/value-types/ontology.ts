import { defineObject, defineValueType } from '@osdk/maker';

const taskStatus = defineValueType({
  apiName: 'taskStatus',
  displayName: 'Task status',
  version: '1.1.0',
  type: {
    type: 'string',
    constraints: [
      {
        constraint: { type: 'oneOf', oneOf: { values: ['open', 'done'], useIgnoreCase: false } },
        failureMessage: { message: 'Use open or done.' },
      },
    ],
  },
});

const money = defineValueType({
  apiName: 'money',
  displayName: 'Money',
  description: 'An amount from 0 to 1000000.',
  version: '1.0.0',
  status: { type: 'deprecated', message: 'Use cost.', deadline: '2027-01-01' },
  type: {
    type: 'decimal',
    constraints: [{ constraint: { type: 'range', range: { min: '0', max: '1000000.00' } } }],
  },
});

const tags = defineValueType({
  apiName: 'tags',
  displayName: 'Tags',
  version: '2.0.0',
  type: {
    type: { type: 'array', elementType: 'string' },
    constraints: [
      {
        constraint: {
          size: { minSize: 1, maxSize: 5 },
          elementsUnique: true,
          elementsConstraint: {
            type: 'string',
            string: { type: 'regex', regex: { regexPattern: '[a-z]+', usePartialMatch: false } },
          },
        },
        failureMessage: { message: 'Use 1 to 5 lowercase tags.' },
      },
    ],
  },
});

export const task = defineObject({
  apiName: 'Task',
  displayName: 'Task',
  pluralDisplayName: 'Tasks',
  titlePropertyApiName: 'taskId',
  primaryKeyPropertyApiName: 'taskId',
  properties: {
    taskId: { type: 'string', displayName: 'Task ID' },
    status: { type: 'string', valueType: taskStatus },
    budget: { type: { type: 'decimal', precision: 12, scale: 2 }, valueType: money },
    labels: { type: 'string', array: true, valueType: tags },
  },
});
