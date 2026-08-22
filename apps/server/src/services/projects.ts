import type { Db } from "../db.js";
import { subscribeHint, type Bus } from "../bus.js";
import { conflict, forbidden, notFound } from "../errors.js";

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  owner_id: string;
  created_at: string;
}
export interface RoomRow {
  id: string;
  kind: "room";
  project_id: string;
  name: string;
  topic: string;
  visibility: "open" | "invite" | "private";
  created_at: string;
}
export type Role = "owner" | "admin" | "member" | "observer";
const RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, observer: 0 };

export function projectsService(db: Db, bus: Bus) {
  async function bySlug(slug: string) {
    return db.one<ProjectRow>("SELECT * FROM projects WHERE slug = $1", [slug]);
  }
  async function roleOf(projectId: string, userId: string): Promise<Role | undefined> {
    const r = await db.one<{ role: Role }>("SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2", [projectId, userId]);
    return r?.role;
  }
  async function requireRole(projectId: string, userId: string, min: Role) {
    const role = await roleOf(projectId, userId);
    if (!role || RANK[role] < RANK[min]) throw forbidden(`requires ${min} role`);
    return role;
  }

  async function create(ownerId: string, input: { slug: string; name: string; description: string }) {
    if (await bySlug(input.slug)) throw conflict(`project "${input.slug}" exists`);
    const p = (await db.one<ProjectRow>(
      "INSERT INTO projects (slug, name, description, owner_id) VALUES ($1,$2,$3,$4) RETURNING *",
      [input.slug, input.name, input.description, ownerId],
    ))!;
    await db.query("INSERT INTO project_members VALUES ($1,$2,'owner')", [p.id, ownerId]);
    const lobby = await createRoom(p.id, { name: "lobby", visibility: "open", topic: `Welcome to ${p.name}` });
    await db.query("INSERT INTO conv_members (conversation_id, user_id) VALUES ($1,$2)", [lobby.id, ownerId]);
    await subscribeHint(bus, [ownerId], lobby.id);
    return p;
  }

  async function addMember(projectId: string, userId: string, role: Role) {
    await db.query(
      `INSERT INTO project_members VALUES ($1,$2,$3) ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [projectId, userId, role],
    );
    // auto-join lobby
    const lobby = await db.one<RoomRow>("SELECT * FROM conversations WHERE project_id=$1 AND name='lobby'", [projectId]);
    if (lobby) {
      await db.query("INSERT INTO conv_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [lobby.id, userId]);
      await subscribeHint(bus, [userId], lobby.id);
    }
  }
  async function removeMember(projectId: string, userId: string) {
    await db.query("DELETE FROM project_members WHERE project_id=$1 AND user_id=$2", [projectId, userId]);
    await db.query(
      "DELETE FROM conv_members WHERE user_id=$1 AND conversation_id IN (SELECT id FROM conversations WHERE project_id=$2)",
      [userId, projectId],
    );
  }
  async function members(projectId: string) {
    return db.query<{ screen_name: string; kind: string; role: Role }>(
      `SELECT u.screen_name, u.kind, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id=$1 ORDER BY m.role, u.screen_name`,
      [projectId],
    );
  }
  async function listForUser(userId: string) {
    return db.query<ProjectRow & { role: Role }>(
      "SELECT p.*, m.role FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id=$1 ORDER BY p.name",
      [userId],
    );
  }

  async function createRoom(projectId: string, input: { name: string; visibility: string; topic: string }) {
    const exists = await db.one("SELECT 1 FROM conversations WHERE project_id=$1 AND name=$2", [projectId, input.name]);
    if (exists) throw conflict(`room "${input.name}" exists`);
    return (await db.one<RoomRow>(
      "INSERT INTO conversations (kind, project_id, name, visibility, topic) VALUES ('room',$1,$2,$3,$4) RETURNING *",
      [projectId, input.name, input.visibility, input.topic],
    ))!;
  }
  async function rooms(projectId: string) {
    return db.query<RoomRow>("SELECT * FROM conversations WHERE project_id=$1 ORDER BY name", [projectId]);
  }
  async function roomById(id: string) {
    const r = await db.one<RoomRow>("SELECT * FROM conversations WHERE id=$1 AND kind='room'", [id]);
    if (!r) throw notFound("room");
    return r;
  }
  async function joinRoom(room: RoomRow, userId: string) {
    const role = await roleOf(room.project_id, userId);
    if (!role) throw forbidden("not a project member");
    if (room.visibility !== "open") throw forbidden("room is invite-only");
    await db.query("INSERT INTO conv_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [room.id, userId]);
    await subscribeHint(bus, [userId], room.id);
  }
  async function inviteToRoom(room: RoomRow, userId: string) {
    await db.query("INSERT INTO conv_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [room.id, userId]);
    await subscribeHint(bus, [userId], room.id);
  }
  async function leaveRoom(roomId: string, userId: string) {
    await db.query("DELETE FROM conv_members WHERE conversation_id=$1 AND user_id=$2", [roomId, userId]);
  }
  async function setTopic(roomId: string, topic: string) {
    await db.query("UPDATE conversations SET topic=$2 WHERE id=$1", [roomId, topic]);
  }
  /** Locked rooms are readable by every member but writable only by project admins. */
  async function setLocked(roomId: string, locked: boolean) {
    await db.query("UPDATE conversations SET locked=$2 WHERE id=$1", [roomId, locked]);
  }

  return { bySlug, roleOf, requireRole, create, addMember, removeMember, members, listForUser, createRoom, rooms, roomById, joinRoom, inviteToRoom, leaveRoom, setTopic, setLocked };
}
export type ProjectsService = ReturnType<typeof projectsService>;
