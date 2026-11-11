import { zValidator } from '@hono/zod-validator';
import type { ZodType } from 'zod';
import { badRequest } from '../core/errors.js';

/** Zod validation of a JSON body that fails with the standard error envelope. */
export function jsonBody<T extends ZodType>(schema: T) {
  return zValidator('json', schema, (result) => {
    if (!result.success) {
      throw badRequest(
        'Invalid request body',
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
  });
}
