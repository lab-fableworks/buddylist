/** Webhook REST routes. STUB — owned by the webhooks workstream. */
import type { FastifyInstance } from "fastify";
import type { AppContext } from "./app.js";

export function registerWebhookRoutes(_app: FastifyInstance, _ctx: AppContext) {
  // TODO(webhooks): POST/GET/DELETE /api/webhooks, POST /api/webhooks/:id/test, GET /api/webhooks/:id/deliveries
}
