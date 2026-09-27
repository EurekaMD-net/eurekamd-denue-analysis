/**
 * Per-request context, carried across awaits with AsyncLocalStorage so the
 * DB runner can tell who it is serving without threading a parameter
 * through every handler. Set by the auth middleware once it has decided
 * the principal: the shared X-Api-Key (Jarvis) is the priority tier,
 * a browser JWT is not.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  principal?: string;
  priority: boolean;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** True inside a priority request (see middleware/auth.ts). */
export function isPriorityRequest(): boolean {
  return requestContext.getStore()?.priority === true;
}
