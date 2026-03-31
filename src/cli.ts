import path from "node:path";
import { runCompileCommand } from "./commands/compile.js";
import { runFixCommand } from "./commands/fix.js";
import { runInitCommand } from "./commands/init.js";
import { runRunCommand } from "./commands/run.js";
import { writeProjectErrorLog } from "./debug/error-history.js";

const ANSI_RED = "\u001b[31m";
const ANSI_RESET = "\u001b[0m";

type ParsedArgs = {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgv(argv);

  if (!parsed.command || parsed.flags.help) {
    printHelp();
    return;
  }

  try {
    switch (parsed.command) {
      case "init":
        await runInitCommand(parsed);
        return;
      case "compile":
        await runCompileCommand(parsed);
        return;
      case "fix":
        await runFixCommand(parsed);
        return;
      case "run":
        await runRunCommand(parsed);
        return;
      default:
        throw new Error(`Unknown command: ${parsed.command}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistLatestError(parsed, message);
    console.error(`${ANSI_RED}spec error:${ANSI_RESET} ${message}`);
    process.exitCode = 1;
  }
}

function parseArgv(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const nextToken = rest[index + 1];

    if (!nextToken || nextToken.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = nextToken;
    index += 1;
  }

  return { command, positionals, flags };
}

function printHelp(): void {
  console.log(`
SpecOS CLI

Usage:
  spec init --host <url> --auth <token> [--model <name>] [--dist <path>]
  spec init --config <file>
  spec init --project [dir]
  spec compile <projectDir> [--outDir <path>] [--model <name>] [--host <url>] [--debug]
  spec fix <projectDir> [--error <message>] [--latest] [--lastest] [--apply] [--outDir <path>] [--model <name>] [--host <url>]
  spec run <projectDir> [--outDir <path>] [--frontend-only] [--backend-only] [--install] [--watch] [--dev]

Examples:
  spec init --host https://api.openai.com/v1 --auth sk-...
  spec init --config ./spec.global.json
  spec init --project ./examples/todo-app
  spec compile ./examples/todo-app
  spec fix ./examples/todo-app --error "backend start: process emitted a startup error before becoming ready"
  spec fix ./examples/todo-app --latest
  spec fix ./examples/todo-app --latest --apply
  spec run ./examples/todo-app --install
`);
}

export type { ParsedArgs };

async function persistLatestError(parsed: ParsedArgs, message: string): Promise<void> {
  if (!parsed.command || !["compile", "run", "fix"].includes(parsed.command)) {
    return;
  }

  const projectInput = typeof parsed.positionals[0] === "string" ? parsed.positionals[0] : ".";
  const projectDir = path.resolve(process.cwd(), projectInput);

  try {
    await writeProjectErrorLog({
      timestamp: new Date().toISOString(),
      command: parsed.command,
      projectDir,
      cwd: process.cwd(),
      error: message,
      flags: parsed.flags
    });
  } catch {
    // Error logging must never hide the original command failure.
  }
}
