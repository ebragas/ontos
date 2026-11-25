import type { QueryDataType } from '@osdk/foundry.ontologies';
import { ApiError } from './apiError.ts';

export function internalError(): ApiError {
  return new ApiError(500, 'Default:Internal');
}

export function unsupportedFeature(feature: string): ApiError {
  return new ApiError(400, 'Default:InvalidArgument', { feature });
}

export function actionTypeNotFound(actionType: string, publishedApiName: string | undefined): ApiError {
  return new ApiError(
    404,
    'ActionTypeNotFound',
    publishedApiName === undefined ? { actionType } : { actionType, publishedApiName },
  );
}

export function queryNotFound(query: string): ApiError {
  return new ApiError(404, 'QueryNotFound', { query });
}

export function queryVersionNotFound(apiName: string, version: string): ApiError {
  return new ApiError(404, 'QueryVersionNotFound', { apiName, version });
}

export function invalidQueryParameterValue(
  parameterDataType: QueryDataType | undefined,
  parameterId: string,
  parameterValue: unknown,
): ApiError {
  return new ApiError(400, 'InvalidQueryParameterValue', { parameterDataType, parameterId, parameterValue });
}
