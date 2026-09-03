/**
 * Recognizes the agentic CLIs — Claude Code, Codex, Gemini CLI and the like —
 * that hold the terminal for a whole session. Their command only returns when
 * the user quits, so tracking it like an ordinary one would leave the tab
 * "command running" for as long as the tool is open, which says nothing. A
 * recognized session switches terminal activity to the assistant's turns
 * instead: busy while it works, finished when it hands the terminal back.
 */

/** Binary names, as they are typed. Basenames, so a full path also matches. */
const AI_CLIS = new Set([
  "claude",
  "codex",
  "gemini",
  "aider",
  "cursor-agent",
  "copilot",
  "amp",
  "opencode",
  "crush",
  "goose",
  "qwen",
  "droid",
  "openhands",
  "grok",
  // As spelled on npm, for `npx @anthropic-ai/claude-code`.
  "claude-code",
  "gemini-cli",
]);

/** Words that only stand in front of the real command. */
const PREFIXES = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "exec",
  "time",
  "nohup",
  "npx",
  "pnpx",
  "bunx",
  "uvx",
]);

/** Package runners spelled as two words: `pnpm dlx claude`. */
const RUNNERS: Record<string, string[]> = {
  npm: ["exec"],
  pnpm: ["dlx", "exec"],
  yarn: ["dlx"],
  bun: ["x"],
  uv: ["run"],
  deno: ["run"],
};

/**
 * Flags that turn these tools into a one-shot run with no session to follow:
 * `claude -p "..."`, `aider --message ...`, `codex --version`.
 */
const ONE_SHOT_FLAGS = new Set([
  "-p",
  "--print",
  "--prompt",
  "-m",
  "--message",
  "-h",
  "--help",
  "-v",
  "-V",
  "--version",
]);

/** First-argument subcommands that do not open a session. */
const ONE_SHOT_SUBCOMMANDS = new Set([
  "exec",
  "run",
  "mcp",
  "update",
  "upgrade",
  "install",
  "uninstall",
  "doctor",
  "config",
  "login",
  "logout",
  "auth",
  "help",
  "version",
  "completion",
  "setup-token",
  "migrate-installer",
]);

/** `VAR=value` assignments in front of a command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Last path segment, without a Windows executable suffix. */
function binaryName(token: string): string {
  const base = token.split(/[/\\]/).pop() ?? "";
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/**
 * True when the command line starts an interactive session with one of the
 * tools above. `cd repo && claude` counts; a pipeline does not, since a tool
 * reading from a pipe is not driving the terminal.
 */
export function isAiSessionCommand(command: string): boolean {
  return command
    .split(/&&|\|\||;/)
    .filter((segment) => !segment.includes("|"))
    .some(startsAiSession);
}

function startsAiSession(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  let prefixed = false;
  while (index < tokens.length) {
    const token = tokens[index];
    // `sudo -E claude`, `npx -y ...`: options belong to the prefix in front.
    if (ASSIGNMENT.test(token) || (prefixed && token.startsWith("-"))) {
      index += 1;
      continue;
    }
    const name = binaryName(token);
    if (PREFIXES.has(name)) {
      index += 1;
      prefixed = true;
      continue;
    }
    if (RUNNERS[name]?.includes(tokens[index + 1] ?? "")) {
      index += 2;
      prefixed = true;
      continue;
    }
    break;
  }

  if (!AI_CLIS.has(binaryName(tokens[index] ?? ""))) return false;

  const args = tokens.slice(index + 1);
  if (args.some((arg) => ONE_SHOT_FLAGS.has(arg))) return false;
  // Only the first positional word is a subcommand; a quoted opening prompt
  // (`codex "run the tests"`) keeps its quote and never looks like one.
  const first = args.find((arg) => !arg.startsWith("-"));
  return first === undefined || !ONE_SHOT_SUBCOMMANDS.has(first);
}
