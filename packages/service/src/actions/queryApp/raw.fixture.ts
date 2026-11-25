import type { Client } from '@osdk/client';

interface ApiErrorShape {
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly errorName?: string;
  readonly errorInstanceId?: string;
  readonly parameters?: Record<string, unknown>;
}

export interface Answer {
  readonly status: number | undefined;
  readonly body: unknown;
}

export async function post(client: Client, ontology: string, path: string, body: unknown): Promise<Answer> {
  const context = client.__osdkClientContext;
  const base = context.baseUrl.endsWith('/') ? context.baseUrl : `${context.baseUrl}/`;
  const url = new URL(`api/v2/ontologies/${ontology}/${path}`, base);

  try {
    const response = await context.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    return { status: response.status, body: (await response.json()) as unknown };
  } catch (error) {
    const { statusCode, errorCode, errorName, errorInstanceId, parameters } = apiErrorOf(error);

    return { status: statusCode, body: { errorCode, errorName, errorInstanceId, parameters } };
  }
}

export function answerOf(error: unknown): {
  readonly statusCode: number | undefined;
  readonly errorName: string | undefined;
} {
  const { statusCode, errorName } = apiErrorOf(error);

  return { statusCode, errorName };
}

function apiErrorOf(error: unknown): ApiErrorShape {
  return ((error as { cause?: unknown }).cause ?? error) as ApiErrorShape;
}
