import { share } from "./index.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  \x1b[1mfied\x1b[0m — share your tmux session in the browser with E2E encryption

  \x1b[1mUsage:\x1b[0m
    npx fied [options]

  \x1b[1mOptions:\x1b[0m
    --session, -s <name>   tmux session to share (auto-detected if only one)
    --relay <url>          relay server URL (default: https://fied.app)
    --help, -h             show this help

  \x1b[1mExamples:\x1b[0m
    npx fied                       share the only tmux session
    npx fied -s mysession          share a specific session
    npx fied --relay http://localhost:8787   use a local relay
`);
  process.exit(0);
}

const options: { session?: string; relay?: string } = {};

for (let i = 0; i < args.length; i++) {
  if ((args[i] === "--session" || args[i] === "-s") && args[i + 1]) {
    options.session = args[++i];
  } else if (args[i] === "--relay" && args[i + 1]) {
    options.relay = args[++i];
  } else {
    console.error(`Unknown option: ${args[i]}`);
    process.exit(1);
  }
}

share(options).catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
