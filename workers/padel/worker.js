// Padel Worker entry point. Everything lives in padel.js, which tests import directly.
// Only handlers may be exported from a Worker's main module: workerd treats every named export
// as an entrypoint and refuses a constant (found on the first `wrangler dev`, 27 Oct 2026).
import { handleRequest, makeRepo } from './padel.js';

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx, makeRepo(env.DB));
  },
};
