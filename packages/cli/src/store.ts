import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SessionEntry {
  pid: number;
  tmuxSession: string;
  url: string;
  relay: string;
  startedAt: string;
}

const STORE_DIR = join(homedir(), ".fied");
const STORE_FILE = join(STORE_DIR, "sessions.json");

function ensureDir(): void {
  mkdirSync(STORE_DIR, { recursive: true });
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
    const entries = JSON.parse(raw) as SessionEntry[];
    const alive = entries.filter((e) => isAlive(e.pid));
    if (alive.length !== entries.length) {
      saveSessions(alive);
    }
    return alive;
  } catch {
    return [];
  }
}

export function saveSessions(entries: SessionEntry[]): void {
  ensureDir();
  writeFileSync(STORE_FILE, JSON.stringify(entries, null, 2));
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
