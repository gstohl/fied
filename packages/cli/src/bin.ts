import { spawn as spawnChild } from "node:child_process";
import { fileURLToPath } from "node:url";
import { share } from "./index.js";
import { listSessions } from "./tmux.js";
import { loadSessions, stopSession } from "./store.js";
import { pickSession, confirm, pickManageAction, pickStop } from "./prompt.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  \x1b[1mfied\x1b[0m — share your tmux session in the browser with E2E encryption

  \x1b[1mUsage:\x1b[0m
    npx fied [options]

  \x1b[1mOptions:\x1b[0m
    --session, -s <name>   tmux session to share (auto-detected if only one)
    --relay <url>          relay server URL (default: https://fied.app)
    --allow-insecure-relay allow http://localhost relay (dev only)
    --help, -h             show this help

  \x1b[1mExamples:\x1b[0m
    npx fied                       share the only tmux session
    npx fied -s mysession          share a specific session
    npx fied --relay http://localhost:8787   use a local relay
`);
  process.exit(0);
}

if (args.includes("--__daemon")) {
  const options: {
    session?: string;
    relay?: string;
    allowInsecureRelay?: boolean;
    sessionId?: string;
    keyBase64Url?: string;
  } = {};
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--session" || args[i] === "-s") && args[i + 1]) {
      options.session = args[++i];
    } else if (args[i] === "--relay" && args[i + 1]) {
      options.relay = args[++i];
    } else if (args[i] === "--allow-insecure-relay") {
      options.allowInsecureRelay = true;
    } else if (args[i] === "--__session-id" && args[i + 1]) {
      options.sessionId = args[++i];
    } else if (args[i] === "--__key" && args[i + 1]) {
      options.keyBase64Url = args[++i];
    }
  }
  share({ ...options, background: true }).catch(() => process.exit(1));
} else {
  main().catch((err) => {
    console.error("Fatal:", err.message ?? err);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  let relay: string | undefined;
  let session: string | undefined;
  let allowInsecureRelay = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--session" || args[i] === "-s") && args[i + 1]) {
      session = args[++i];
    } else if (args[i] === "--relay" && args[i + 1]) {
      relay = args[++i];
    } else if (args[i] === "--allow-insecure-relay") {
      allowInsecureRelay = true;
    } else if (!args[i].startsWith("-")) {
      continue;
    } else {
      console.error(`Unknown option: ${args[i]}`);
      process.exit(1);
    }
  }

  const active = loadSessions();
  if (active.length > 0 && !session) {
    console.error("");
    console.error("  \x1b[1m\x1b[32mfied\x1b[0m — active sessions");
    console.error("");
    for (let i = 0; i < active.length; i++) {
      const s = active[i];
      const age = timeSince(new Date(s.startedAt));
      console.error(`    \x1b[36m${i + 1}\x1b[0m) \x1b[1m${s.tmuxSession}\x1b[0m  ${age} ago`);
      console.error(`       relay: ${s.relay}`);
      console.error(`       session: ${s.sessionId}`);
    }

    const action = await pickManageAction(active.length);

    if (action === "q") {
      process.exit(0);
    }

    if (action === "s") {
      const idx = await pickStop(active.length);
      if (idx !== null) {
        const entry = active[idx];
        stopSession(entry.pid);
        console.error(`  \x1b[32mStopped\x1b[0m ${entry.tmuxSession}`);
      }
      process.exit(0);
    }

    if (action.startsWith("stop:")) {
      const idx = parseInt(action.split(":")[1], 10) - 1;
      const entry = active[idx];
      stopSession(entry.pid);
      console.error(`  \x1b[32mStopped\x1b[0m ${entry.tmuxSession}`);
      process.exit(0);
    }

  }

  const tmuxSessions = listSessions();
  if (tmuxSessions.length === 0) {
    console.error("No tmux sessions found. Start one with: tmux new -s mysession");
    process.exit(1);
  }

  if (!session) {
    if (tmuxSessions.length === 1) {
      session = tmuxSessions[0].name;
    } else {
      session = await pickSession(tmuxSessions.map((s) => {
        const tag = s.attached ? " \x1b[2m(attached)\x1b[0m" : "";
        return `${s.name} — ${s.windows} window${s.windows !== 1 ? "s" : ""}${tag}`;
      }));
      session = session.split(" — ")[0].trim();
    }
  }

  if (!session) {
    throw new Error("No tmux session selected");
  }

  await share({
    session,
    relay,
    allowInsecureRelay,
    onShareUrl: async (url) => {
      const background = await confirm("Run in background?");
      if (!background) {
        return;
      }

      const parsed = parseShareUrl(url);
      const child = spawnBackground({
        session,
        relay,
        allowInsecureRelay,
        sessionId: parsed.sessionId,
        keyBase64Url: parsed.keyBase64Url,
      });

      console.error("");
      console.error(`  \x1b[1m\x1b[32mfied\x1b[0m — moved to background (PID ${child.pid})`);
      console.error(`  Session: ${session}`);
      console.error("  Same share link stays active.");
      console.error("  Run \x1b[1mnpx fied\x1b[0m again to manage.");
      console.error("");

      setTimeout(() => process.exit(0), 300);
    },
  });
}

function spawnBackground(options: {
  session: string;
  relay?: string;
  allowInsecureRelay: boolean;
  sessionId: string;
  keyBase64Url: string;
}) {
  const binPath = fileURLToPath(import.meta.url);
  const childArgs = [
    "--__daemon",
    "--session",
    options.session,
    "--__session-id",
    options.sessionId,
    "--__key",
    options.keyBase64Url,
  ];
  if (options.relay) childArgs.push("--relay", options.relay);
  if (options.allowInsecureRelay) childArgs.push("--allow-insecure-relay");

  const child = spawnChild(process.execPath, [binPath, ...childArgs], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

function parseShareUrl(url: string): { sessionId: string; keyBase64Url: string } {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/s\/([A-Za-z0-9_-]{8,64})$/);
  if (!match || !parsed.hash) {
    throw new Error("Invalid share URL");
  }

  return {
    sessionId: match[1],
    keyBase64Url: parsed.hash.slice(1),
  };
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
