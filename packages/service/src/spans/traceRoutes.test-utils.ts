import { afterAll, afterEach, beforeEach } from 'vitest';
import { recordSpans, setRouteRecorder } from '../tracing.test-utils.ts';

const recorder = recordSpans();

setRouteRecorder(recorder);

const check = async (): Promise<void> => (await import('../routeHarness.test-utils.ts')).checkRouteTraces(recorder);

beforeEach(check);

afterEach(check);

afterAll(() => {
  recorder.stop();

  setRouteRecorder(undefined);
});
