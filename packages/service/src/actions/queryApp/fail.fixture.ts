export default async function fail(): Promise<string> {
  throw new Error('a plain error');
}
