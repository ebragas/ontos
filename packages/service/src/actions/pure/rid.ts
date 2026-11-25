export function newActionRid(): string {
  return `ri.actions.main.action.${crypto.randomUUID()}`;
}
