// The API on the Pages site: every /api/* request goes to the same handler
// the Worker uses locally. The Durable Objects (rooms, pairing, limits,
// budget) live in the private shuttersense-core Worker and are bound here.

import { handleApi, type Env } from "../../../worker/index.ts";

export const onRequest: PagesFunction<Env> = (ctx) => handleApi(ctx.request, ctx.env, ctx as unknown as ExecutionContext);
