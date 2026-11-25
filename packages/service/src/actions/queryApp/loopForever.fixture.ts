export const LOOP_FOREVER_CHANNEL = 'queryErrors.sql.test.ts loopForever';

export default async function loopForever(): Promise<string> {
  new BroadcastChannel(LOOP_FOREVER_CHANNEL).postMessage('looping');

  for (;;) {
    void 0;
  }
}
