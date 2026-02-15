import { createInterface } from "node:readline";

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function pickSession(names: string[]): Promise<string> {
  console.error("");
  console.error("  \x1b[1mSelect a tmux session:\x1b[0m");
  console.error("");
  for (let i = 0; i < names.length; i++) {
    console.error(`    \x1b[36m${i + 1}\x1b[0m) ${names[i]}`);
  }
  console.error("");

  while (true) {
    const answer = await ask("  Choice: ");
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < names.length) {
      return names[idx];
    }
    console.error(`  \x1b[33mEnter a number between 1 and ${names.length}\x1b[0m`);
  }
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await ask(`  ${question} [${hint}]: `);
  if (answer === "") return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

export async function pickManageAction(count: number): Promise<string> {
  console.error("");
  console.error(`    \x1b[36mn\x1b[0m) Start new session`);
  console.error(`    \x1b[36ms\x1b[0m) Stop a session`);
  console.error(`    \x1b[36mq\x1b[0m) Quit`);
  console.error("");

  while (true) {
    const answer = await ask("  Action: ");
    const a = answer.toLowerCase();
    if (a === "n" || a === "s" || a === "q") return a;
    // Allow picking a session number to stop it directly
    const idx = parseInt(answer, 10);
    if (idx >= 1 && idx <= count) return `stop:${idx}`;
    console.error("  \x1b[33mEnter n, s, or q\x1b[0m");
  }
}

export async function pickStop(count: number): Promise<number | null> {
  const answer = await ask("  Stop which session #: ");
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < count) return idx;
  return null;
}
