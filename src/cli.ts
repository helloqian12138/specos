import { runCompileCommand } from "./commands/compile.js";
import { runInitCommand } from "./commands/init.js";

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
      default:
        throw new Error(`Unknown command: ${parsed.command}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`spec error: ${message}`);
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
  spec compile <projectDir> [--outDir <path>] [--model <name>] [--host <url>]

Examples:
  spec init --host https://api.openai.com/v1 --auth sk-...
  spec init --config ./spec.global.json
  spec init --project ./examples/todo-app
  spec compile ./examples/todo-app
`);
}

export type { ParsedArgs };
