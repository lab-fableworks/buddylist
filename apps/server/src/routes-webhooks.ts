/** Webhook REST routes. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "./app.js";
import { badRequest } from "./errors.js";
import { WEBHOOK_EVENTS } from "./services/webhooks.js";

const parse = <T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
};
const P = <T extends Record<string, string>>(req: { params: unknown }) => req.params as T;
const Q = <T extends Record<string, string | undefined>>(req: { query: unknown }) => req.query as T;

const CreateWebhook = z.object({
  url: z.string().min(1),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  secret: z.string().min(8).optional(),
});
const UpdateWebhook = z.object({
  url: z.string().min(1).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  active: z.boolean().optional(),
});

export function registerWebhookRoutes(app: FastifyInstance, ctx: AppContext) {
  const { webhooks } = ctx;

  app.post("/api/webhooks", async (req, reply) => {
    const body = parse(CreateWebhook, req.body);
    const hook = await webhooks.create(req.user.id, body);
    // Secret is only ever returned here, on create.
    return reply.status(201).send(hook);
  });

  app.get("/api/webhooks", async (req) => webhooks.list(req.user.id));

  app.delete("/api/webhooks/:id", async (req) => {
    await webhooks.remove(req.user.id, P<{ id: string }>(req).id);
    return { ok: true };
  });

  app.patch("/api/webhooks/:id", async (req) => {
    const body = parse(UpdateWebhook, req.body);
    return webhooks.update(req.user.id, P<{ id: string }>(req).id, body);
  });

  app.get("/api/webhooks/:id/deliveries", async (req) => {
    const q = Q<{ limit?: string }>(req);
    return webhooks.deliveries(req.user.id, P<{ id: string }>(req).id, q.limit ? Number(q.limit) : undefined);
  });

  app.post("/api/webhooks/:id/test", async (req, reply) => {
    const result = await webhooks.test(req.user.id, P<{ id: string }>(req).id);
    return reply.status(202).send(result);
  });
}
