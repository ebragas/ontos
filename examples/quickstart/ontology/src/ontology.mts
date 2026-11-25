import { defineCreateObjectAction, defineObject } from '@osdk/maker';

const task = defineObject({
  apiName: 'Task',
  displayName: 'Task',
  pluralDisplayName: 'Tasks',
  description: 'A task tracked in this Ontology.',
  titlePropertyApiName: 'title',
  primaryKeyPropertyApiName: 'taskId',
  properties: {
    taskId: {
      type: 'string',
      displayName: 'Task ID',
      description: 'Unique identifier for the task.',
    },
    title: {
      type: 'string',
      displayName: 'Title',
      description: 'Short summary of the task.',
      nullability: { noNulls: true, noEmptyCollections: false },
    },
    completed: {
      type: 'boolean',
      displayName: 'Completed',
      description: 'Whether the task is complete.',
    },
  },
  editsEnabled: true,
  editsHistoryConfig: { enabled: true },
  includeEmptyBackingDatasource: true,
});

defineCreateObjectAction({
  objectType: task,
  apiName: 'create-task',
  displayName: 'Create Task',
  description: 'Create a new task.',
  parameterConfiguration: {
    taskId: { description: 'Unique identifier for the task.' },
    title: { description: 'Short summary of the task.' },
    completed: { description: 'Whether the task is complete.' },
  },
});
