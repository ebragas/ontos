import type { Db, DbFailure } from '../../db/index.ts';
import {
  ApiError,
  caught,
  settle,
  unsupportedFeature,
  type AsyncFallible,
  type Fallible,
  type Fault,
} from '../../errors/index.ts';
import type { PublishCtx, RouteInput } from '../../handler/index.ts';
import { isRecord, readOsdkSets, type CompiledOntology } from '../../ontology/index.ts';
import { convert } from '../convert.ts';
import { checkGrantsFile } from '../grantsCheck.ts';
import type { CheckScope } from '../install.ts';
import { publishOntology, type PublishLog } from '../publishOntology.ts';
import { readNewestVersion, refuseOtherProduct } from '../versions.ts';
import { checkOsdkSet, deprecationWarning } from './osdkSets.ts';
import { readProduct, readRequest } from './request.ts';
import type { CheckedRequest } from './requestTypes.ts';

function checkScope(caller: PublishCtx['caller']): CheckScope {
  switch (caller.kind) {
    case 'publish':
    case 'check':
      return 'product';
    case 'person':
    case 'service':
      return { organization: caller.organization };
  }
}

export async function* publish(
  input: RouteInput,
  ctx: PublishCtx,
  db: Db,
): AsyncFallible<Response, ApiError | DbFailure | Fault> {
  yield* refuseOtherProduct(db, yield* readProduct(isRecord(input.body) ? input.body['product'] : undefined));

  const request = yield* readRequest(input.body);
  const { productRid } = ctx.settings;
  const versionBefore = (yield* readNewestVersion(db, request.product))?.version ?? 0;
  const { ontology, warnings } = yield* prepared(request, productRid, versionBefore, ctx);

  const response = yield* publishOntology(db, {
    product: request.product,
    productRid,
    ontology,
    request,
    publisher: ctx.caller.user,
    mode: request.validateOnly ? { kind: 'check', scope: checkScope(ctx.caller) } : { kind: 'apply' },
    log: (publish) => ctx.log({ publish }),
    workos: ctx.workos,
  });

  const merged = [...warnings, ...(response.warnings ?? [])];

  return Response.json(merged.length > 0 ? { ...response, warnings: merged } : response);
}

function* prepared(
  request: CheckedRequest,
  productRid: string,
  versionBefore: number,
  ctx: PublishCtx,
): Fallible<{ ontology: CompiledOntology; warnings: string[] }, ApiError | Fault> {
  const warnings: string[] = [];
  let done = false;

  try {
    const listed = readOsdkSets();
    const warning = deprecationWarning(listed, yield* checkOsdkSet(listed, request.osdkSet));

    if (warning) warnings.push(warning);

    const converted = caught(() => settle(convert(request, productRid, versionBefore + 1)));

    if (!converted.ok) return yield { kind: 'fault', error: converted.error };

    if (!converted.value.ok) return yield unsupportedFeature(converted.value.error.message);

    const ontology = converted.value.value;

    const check = checkGrantsFile(ontology, request.grants, {
      functions: request.functions !== undefined,
      validateOnly: request.validateOnly,
    });

    if (check.problems.length > 0)
      return yield new ApiError(400, 'Default:InvalidArgument', { part: 'grants', problems: check.problems });

    warnings.push(...check.warnings);

    done = true;

    return { ontology, warnings };
  } finally {
    if (!done) {
      const log: PublishLog = {
        outcome: 'failed',
        lockWaitMs: 0,
        changes: [],
        versionBefore,
        versionAfter: versionBefore,
      };

      ctx.log({ publish: log });
    }
  }
}
