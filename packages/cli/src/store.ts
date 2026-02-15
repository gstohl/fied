import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SessionEntry {
  pid: number;
  tmuxSession: string;
  sessionId: string;
  relay: string;
  startedAt: string;
}

type LegacySessionEntry = SessionEntry & { url?: string };

const STORE_DIR = join(homedir(), ".fied");
const STORE_FILE = join(STORE_DIR, "sessions.json");

function ensureDir(): void {
  mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STORE_DIR, 0o700);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function loadSessions(): SessionEntry[] {
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const entries = JSON.parse(raw) as LegacySessionEntry[];
    const normalized: SessionEntry[] = [];
    let needsRewrite = false;

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.pid !== "number") continue;
      if (typeof entry.tmuxSession !== "string") continue;
      if (typeof entry.relay !== "string") continue;
      if (typeof entry.startedAt !== "string") continue;

      const sessionId = typeof entry.sessionId === "string"
        ? entry.sessionId
        : extractSessionIdFromUrl(entry.url);
      if (typeof entry.sessionId !== "string" || typeof entry.url === "string") {
        needsRewrite = true;
      }

      if (!sessionId) continue;

      normalized.push({
        pid: entry.pid,
        tmuxSession: entry.tmuxSession,
        sessionId,
        relay: entry.relay,
        startedAt: entry.startedAt,
      });
    }

    const alive = normalized.filter((e) => isAlive(e.pid));
    if (alive.length !== entries.length || needsRewrite) {
      saveSessions(alive);
    }
    return alive;
  } catch {
    return [];
  }
}

export function saveSessions(entries: SessionEntry[]): void {
  ensureDir();
  writeFileSync(STORE_FILE, JSON.stringify(entries, null, 2), { mode: 0o600 });
  chmodSync(STORE_FILE, 0o600);
}

export function addSession(entry: SessionEntry): void {
  const entries = loadSessions();
  entries.push(entry);
  saveSessions(entries);
}

export function removeSession(pid: number): void {
  const entries = loadSessions();
  saveSessions(entries.filter((e) => e.pid !== pid));
}

export function stopSession(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    removeSession(pid);
    return true;
  } catch {
    removeSession(pid);
    return false;
  }
}

function extractSessionIdFromUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/s\/([A-Za-z0-9_-]{8,64})$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
