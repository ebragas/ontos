export class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);

    return `$${this.values.length}`;
  }
}
