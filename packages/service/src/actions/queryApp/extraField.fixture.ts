export default async function extraField(): Promise<{ readonly label: string; readonly secret: string }> {
  return { label: 'shown', secret: 'hidden' };
}
