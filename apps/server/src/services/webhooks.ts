/**
 * Outbound webhooks: registration + at-least-once delivery with HMAC signatures and retry.
 * STUB — implementation owned by the webhooks workstream.
 */
import type { Db } from "../db.js";
import type { Bus } from "../bus.js";
import type { UsersService } from "./users.js";

export interface WebhookRow {
  id: string;
  user_id: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
  created_at: string;
}

export function webhooksService(db: Db, bus: Bus, users: UsersService) {
  void db;
  void bus;
  void users;

  /** Enqueue an event for every webhook of `userId` subscribed to it. */
  async function emit(_userId: string, _event: string, _payload: unknown): Promise<void> {
    // TODO(webhooks)
  }
  /** Start the background delivery worker. */
  function start(): void {
    // TODO(webhooks)
  }
  /** Stop the worker (called on server close). */
  function stop(): void {
    // TODO(webhooks)
  }

  return { emit, start, stop };
}
export type WebhooksService = ReturnType<typeof webhooksService>;
