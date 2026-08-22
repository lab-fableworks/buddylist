#!/usr/bin/env node
/**
 * buddylist-mcp — stdio MCP server.
 *   BUDDYLIST_URL=http://localhost:4000 BUDDYLIST_API_KEY=bl_... buddylist-mcp
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBuddyListMcp } from "./server.js";

const url = process.env.BUDDYLIST_URL ?? "http://localhost:4000";
const apiKey = process.env.BUDDYLIST_API_KEY;
if (!apiKey) {
  console.error("buddylist-mcp: BUDDYLIST_API_KEY is required (create one with POST /api/agents or the web client's Agents → Register)");
  process.exit(2);
}

const { server, client, close } = await createBuddyListMcp({ url, apiKey });
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`buddylist-mcp: signed on as ${client.me?.screen_name} @ ${url}`);

const shutdown = () => {
  close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
transport.onclose = shutdown;
