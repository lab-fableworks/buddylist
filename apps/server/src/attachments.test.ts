import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, bootstrapAdmin } from "./app.js";

let app: Awaited<ReturnType<typeof buildApp>>["app"];
let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
let base: string;
let storageDir: string;
let adminKey: string;

const api = async (key: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
};

/** Raw binary PUT, bypassing the JSON helper above (this is what the upload step needs). */
const putBytes = async (key: string, path: string, bytes: Buffer, contentType = "application/octet-stream") => {
  const res = await fetch(base + path, {
    method: "PUT",
    headers: { authorization: `Bearer ${key}`, "content-type": contentType },
    body: new Uint8Array(bytes),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
};

const getBytes = async (key: string, path: string) => {
  const res = await fetch(base + path, { headers: { authorization: `Bearer ${key}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
};

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

beforeAll(async () => {
  storageDir = mkdtempSync(join(tmpdir(), "buddylist-attachments-"));
  ({ app, ctx } = await buildApp({ pgliteDir: undefined, storageDir }));
  adminKey = (await bootstrapAdmin(ctx, "attach-admin", "attach-admin@example.com"))!;
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await app.close();
  rmSync(storageDir, { recursive: true, force: true });
});

describe("attachments", () => {
  let uploaderKey: string, memberKey: string, outsiderKey: string;
  const fileBytes = Buffer.from("hello direct connect, this is a test file\n".repeat(100), "utf8");

  it("sets up an uploader, a conversation peer, and an outsider", async () => {
    const up = await api(adminKey, "POST", "/api/agents", { screen_name: "Uploader" });
    const mem = await api(adminKey, "POST", "/api/agents", { screen_name: "Member" });
    const out = await api(adminKey, "POST", "/api/agents", { screen_name: "Outsider" });
    expect(up.status).toBe(201);
    uploaderKey = up.json.api_key;
    memberKey = mem.json.api_key;
    outsiderKey = out.json.api_key;
  });

  it("rejects a declared size over 25MB up front", async () => {
    const r = await api(uploaderKey, "POST", "/api/attachments", { filename: "big.bin", mime: "application/octet-stream", size: 26 * 1024 * 1024 });
    expect(r.status).toBe(400);
  });

  let attachmentId: string;
  let uploadPath: string;

  it("creates a pending attachment and returns an upload url", async () => {
    const r = await api(uploaderKey, "POST", "/api/attachments", { filename: "notes.txt", mime: "text/plain", size: fileBytes.byteLength });
    expect(r.status).toBe(201);
    expect(r.json.id).toBeTruthy();
    expect(r.json.upload_url).toContain(`/api/attachments/${r.json.id}/content?token=`);
    attachmentId = r.json.id;
    uploadPath = r.json.upload_url.replace(base, "");
  });

  it("rejects upload with a missing/bad/mismatched token", async () => {
    expect((await putBytes(uploaderKey, `/api/attachments/${attachmentId}/content`, fileBytes)).status).toBe(401);
    expect((await putBytes(uploaderKey, `/api/attachments/${attachmentId}/content?token=not-a-real-token`, fileBytes)).status).toBe(401);
    // token minted for THIS attachment used against a different attachment id -> mismatch
    const other = await api(uploaderKey, "POST", "/api/attachments", { filename: "other.txt", mime: "text/plain", size: 1 });
    const otherToken = new URL(other.json.upload_url, base).searchParams.get("token")!;
    expect((await putBytes(uploaderKey, `/api/attachments/${attachmentId}/content?token=${otherToken}`, fileBytes)).status).toBe(401);
  });

  it("is visible only to the uploader before it's linked to any message", async () => {
    const asUploader = await api(uploaderKey, "GET", `/api/attachments/${attachmentId}`);
    expect(asUploader.status).toBe(200);
    const asOutsider = await api(outsiderKey, "GET", `/api/attachments/${attachmentId}`);
    expect(asOutsider.status).toBe(404);
    const asMember = await api(memberKey, "GET", `/api/attachments/${attachmentId}`);
    expect(asMember.status).toBe(404);
  });

  it("uploads the bytes via the presigned-style url and records real size/sha256", async () => {
    const r = await putBytes(uploaderKey, uploadPath, fileBytes);
    expect(r.status).toBe(200);
    expect(r.json.size).toBe(fileBytes.byteLength);
    expect(r.json.sha256).toBe(sha256(fileBytes));
    expect(r.json.uploaded_at).toBeTruthy();

    const meta = await api(uploaderKey, "GET", `/api/attachments/${attachmentId}`);
    expect(meta.json.size).toBe(fileBytes.byteLength);
    expect(meta.json.sha256).toBe(sha256(fileBytes));
  });

  it("rejects a second upload to an already-uploaded attachment", async () => {
    const r2 = await api(uploaderKey, "POST", "/api/attachments", { filename: "x.bin", mime: "application/octet-stream", size: fileBytes.byteLength });
    const path = new URL(r2.json.upload_url, base).pathname + new URL(r2.json.upload_url, base).search;
    expect((await putBytes(uploaderKey, path, fileBytes)).status).toBe(200);
    expect((await putBytes(uploaderKey, path, fileBytes)).status).toBe(409); // already uploaded, and the token was single-use anyway (401 also acceptable)
  });

  it("rejects an oversize body at upload time even if the declared size lied", async () => {
    const r = await api(uploaderKey, "POST", "/api/attachments", { filename: "lied.bin", mime: "application/octet-stream", size: 10 });
    const path = new URL(r.json.upload_url, base).pathname + new URL(r.json.upload_url, base).search;
    const tooBig = Buffer.alloc(26 * 1024 * 1024, 1);
    const res = await putBytes(uploaderKey, path, tooBig);
    expect([400, 413]).toContain(res.status);
  });

  let messageId: string;

  it("links the attachment to a message the uploader sent, then it's visible to conversation members", async () => {
    const im = await api(uploaderKey, "POST", "/api/ims/Member/messages", { body: "check this out", attachments: [] });
    expect(im.status).toBe(201);
    messageId = im.json.id;

    // a non-sender cannot link it
    const badLink = await api(memberKey, "POST", `/api/messages/${messageId}/attachments`, { attachment_ids: [attachmentId] });
    expect(badLink.status).toBe(403);

    const link = await api(uploaderKey, "POST", `/api/messages/${messageId}/attachments`, { attachment_ids: [attachmentId] });
    expect(link.status).toBe(201);

    const listed = await api(memberKey, "GET", `/api/messages/${messageId}/attachments`);
    expect(listed.status).toBe(200);
    expect(listed.json.map((a: { id: string }) => a.id)).toEqual([attachmentId]);

    // now visible to the conversation member (not just the uploader)
    const meta = await api(memberKey, "GET", `/api/attachments/${attachmentId}`);
    expect(meta.status).toBe(200);
  });

  it("downloads byte-for-byte identical content with correct headers for a member, and denies an outsider", async () => {
    const asMember = await getBytes(memberKey, `/api/attachments/${attachmentId}/content`);
    expect(asMember.status).toBe(200);
    expect(asMember.buf.equals(fileBytes)).toBe(true);
    expect(sha256(asMember.buf)).toBe(sha256(fileBytes));
    expect(asMember.headers.get("content-type")).toBe("text/plain");
    expect(asMember.headers.get("content-disposition")).toMatch(/inline/);
    expect(asMember.headers.get("content-disposition")).toMatch(/notes\.txt/);
    expect(asMember.headers.get("x-content-type-options")).toBe("nosniff");

    const asOutsider = await getBytes(outsiderKey, `/api/attachments/${attachmentId}/content`);
    expect([403, 404]).toContain(asOutsider.status);
  });

  it("forces attachment (not inline) disposition for non-safe mime types like html", async () => {
    const r = await api(uploaderKey, "POST", "/api/attachments", { filename: "evil.html", mime: "text/html", size: 5 });
    const path = new URL(r.json.upload_url, base).pathname + new URL(r.json.upload_url, base).search;
    await putBytes(uploaderKey, path, Buffer.from("<b>x</b>"), "text/html");
    const dl = await getBytes(uploaderKey, `/api/attachments/${r.json.id}/content`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  it("forMessages / linkage cover multiple attachments in one message with no N+1 surprises", async () => {
    const a1 = await api(uploaderKey, "POST", "/api/attachments", { filename: "a1.txt", mime: "text/plain", size: 3 });
    const a2 = await api(uploaderKey, "POST", "/api/attachments", { filename: "a2.txt", mime: "text/plain", size: 3 });
    for (const a of [a1, a2]) {
      const path = new URL(a.json.upload_url, base).pathname + new URL(a.json.upload_url, base).search;
      await putBytes(uploaderKey, path, Buffer.from("abc"));
    }
    const im = await api(uploaderKey, "POST", "/api/ims/Member/messages", { body: "two files" });
    const link = await api(uploaderKey, "POST", `/api/messages/${im.json.id}/attachments`, { attachment_ids: [a1.json.id, a2.json.id] });
    expect(link.status).toBe(201);
    const listed = await api(memberKey, "GET", `/api/messages/${im.json.id}/attachments`);
    expect(listed.json.map((a: { id: string }) => a.id).sort()).toEqual([a1.json.id, a2.json.id].sort());
  });

  it("a caller cannot link an attachment they don't own", async () => {
    const foreign = await api(memberKey, "POST", "/api/attachments", { filename: "not-yours.txt", mime: "text/plain", size: 3 });
    const path = new URL(foreign.json.upload_url, base).pathname + new URL(foreign.json.upload_url, base).search;
    await putBytes(memberKey, path, Buffer.from("abc"));
    const im = await api(uploaderKey, "POST", "/api/ims/Member/messages", { body: "trying to steal a file" });
    const link = await api(uploaderKey, "POST", `/api/messages/${im.json.id}/attachments`, { attachment_ids: [foreign.json.id] });
    expect(link.status).toBe(403);
  });

  it("ordinary JSON endpoints still work fine after the binary content-type parser is registered", async () => {
    const me = await api(uploaderKey, "GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.json.screen_name).toBe("Uploader");
    const send = await api(uploaderKey, "POST", "/api/ims/Member/messages", { body: "still json here" });
    expect(send.status).toBe(201);
    expect(send.json.body).toBe("still json here");
  });
});
