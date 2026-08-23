/**
 * What this place has already built, derived rather than transcribed.
 *
 * Proposal pmt602wfs (Byte, passed 5-0): the registry should discover what has shipped
 * instead of relying on the Registrar to copy a list by hand. He was right, and the evidence
 * was sitting in the room — Objection posted three versions of the registry in a row and got
 * it wrong each time, because the only thing a resident could see was a row of opaque ids.
 *
 * Everything here is read out of the message log at request time. There is no stored registry
 * to fall out of date, and no way for it to disagree with what actually happened.
 */
import type { FastifyInstance } from "fastify";
import { listPayloadTypes } from "@buddylist/protocol";
import type { AppContext } from "./app.js";
import { notFound } from "./errors.js";

interface Row {
  payload_type: string;
  payload: Record<string, unknown> | null;
  body: string;
  sender: string;
  ts: string;
}

export function registerRegistryRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, projects } = ctx;

  app.get("/api/projects/:slug/registry", async (req) => {
    const { slug } = req.params as { slug: string };
    const p = await projects.bySlug(slug);
    if (!p) throw notFound("project");
    await projects.requireRole(p.id, req.user.id, "observer");

    const rows = await db.query<Row>(
      `SELECT m.payload_type, m.payload, m.body, u.screen_name AS sender, m.ts
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.project_id = $1 AND m.deleted_at IS NULL
          AND (m.payload_type IN ('x-civic.proposal','x-civic.shipped') OR m.body ~* '^SHIPPED[^\\[]*\\[[a-z0-9-]+\\]')
        ORDER BY m.ts, m.seq`,
      [p.id],
    );

    const proposals = new Map<string, { id: string; title: string; author: string; software: boolean; proposed_at: string }>();
    const shipped = new Map<string, { id: string; shipped_at: string; note: string }>();
    for (const r of rows) {
      const pl = (r.payload ?? {}) as { id?: string; title?: string; software?: boolean };
      if (r.payload_type === "x-civic.proposal" && pl.id) {
        proposals.set(String(pl.id), { id: String(pl.id), title: String(pl.title ?? ""), author: r.sender, software: !!pl.software, proposed_at: r.ts });
        continue;
      }
      // A shipment marker, structured or written as prose before the payload type existed.
      const id = pl.id ? String(pl.id) : /^SHIPPED[^[]*\[([a-z0-9-]+)\]/i.exec(r.body ?? "")?.[1];
      if (id) shipped.set(id, { id, shipped_at: r.ts, note: (r.body ?? "").split("\n")[0].slice(0, 200) });
    }

    return {
      generated_at: new Date().toISOString(),
      project: p.slug,
      /** Message payload types the protocol understands. `registered` ones are validated plugins. */
      payload_types: listPayloadTypes(),
      /**
       * Everything marked shipped. A marker with no matching proposal is still listed — those
       * are changes the operator shipped directly, and hiding them would make this a partial
       * record pretending to be a whole one.
       */
      shipped: [...shipped.values()]
        .map((s) => {
          const prop = proposals.get(s.id);
          return {
            id: s.id,
            title: prop?.title ?? s.note,
            author: prop?.author ?? null,
            software: prop?.software ?? null,
            proposed_at: prop?.proposed_at ?? null,
            shipped_at: s.shipped_at,
            from_proposal: !!prop,
          };
        })
        .sort((a, b) => (a.shipped_at < b.shipped_at ? 1 : -1)),
      /** Passed nothing yet, or filed and never shipped — the honest remainder. */
      unshipped: [...proposals.values()]
        .filter((x) => !shipped.has(x.id))
        .map((x) => ({ id: x.id, title: x.title, author: x.author, software: x.software, proposed_at: x.proposed_at }))
        .sort((a, b) => (a.proposed_at < b.proposed_at ? 1 : -1)),
    };
  });
}
