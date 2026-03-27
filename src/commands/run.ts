import path from "node:path";
import net from "node:net";
import { ChildProcess, spawn } from "node:child_process";
import { ParsedArgs } from "../cli.js";
import { loadGlobalConfig } from "../config/global-config.js";
import { loadProjectConfig } from "../config/project-config.js";
import { fileExists, readTextFile } from "../utils/fs.js";

type RunTarget = "frontend" | "backend";
type RuntimeAddresses = {
  frontendUrl?: string;
  backendUrl?: string;
  mongoUri?: string;
};

export async function runRunCommand(parsed: ParsedArgs): Promise<void> {
  const projectInput = parsed.positionals[0];

  if (!projectInput) {
    throw new Error("run requires a project directory, for example: spec run ./examples/users");
  }

  const projectDir = path.resolve(process.cwd(), projectInput);
  const globalConfig = await loadGlobalConfig();
  const projectConfig = await loadProjectConfig(projectDir);
  const outDir = path.resolve(
    projectDir,
    stringFlag(parsed.flags.outDir) ?? projectConfig.outDir ?? globalConfig.dist ?? "./dist"
  );

  const frontendOnly = parsed.flags["frontend-only"] === true;
  const backendOnly = parsed.flags["backend-only"] === true;
  const install = parsed.flags.install === true;
  const dev = parsed.flags.dev === true || parsed.flags.watch === true;

  if (frontendOnly && backendOnly) {
    throw new Error("run cannot use --frontend-only and --backend-only together");
  }

  const targets = await detectRunTargets(outDir, { frontendOnly, backendOnly });
  if (targets.length === 0) {
    throw new Error(`No runnable frontend or backend project found in ${outDir}`);
  }

  if (install) {
    await installDependencies(outDir, targets);
  }

  const addresses = await resolveRuntimeAddresses(outDir, targets, dev);
  printRuntimeAddresses(addresses, targets, dev);

  if (targets.includes("backend")) {
    await checkMongoConnectivity(addresses.mongoUri);
  }

  await runTargets(outDir, targets, dev);
}

async function detectRunTargets(
  outDir: string,
  options: { frontendOnly: boolean; backendOnly: boolean }
): Promise<RunTarget[]> {
  const candidates: RunTarget[] = [];

  if (!options.backendOnly && (await fileExists(path.join(outDir, "frontend", "package.json")))) {
    candidates.push("frontend");
  }

  if (
    !options.frontendOnly &&
    ((await fileExists(path.join(outDir, "backend", "app.py"))) ||
      (await fileExists(path.join(outDir, "backend", "requirements.txt"))))
  ) {
    candidates.push("backend");
  }

  return candidates;
}

async function installDependencies(outDir: string, targets: RunTarget[]): Promise<void> {
  for (const target of targets) {
    if (target === "frontend") {
      await runForegroundCommand("npm", ["install"], path.join(outDir, "frontend"), "frontend:install");
      continue;
    }

    const requirementsPath = path.join(outDir, "backend", "requirements.txt");
    if (await fileExists(requirementsPath)) {
      await runForegroundCommand(
        "python3",
        ["-m", "pip", "install", "-r", "requirements.txt"],
        path.join(outDir, "backend"),
        "backend:install"
      );
    }
  }
}

async function runTargets(outDir: string, targets: RunTarget[], dev: boolean): Promise<void> {
  const running = targets.map(target => startTargetProcess(outDir, target, dev));
  const exitPromises = running.map(child => waitForExit(child));

  const forwardSignal = (signal: NodeJS.Signals) => {
    for (const child of running) {
      child.kill(signal);
    }
  };

  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);

  try {
    const firstExit = await waitForFirstExit(running, exitPromises);
    terminateOtherProcesses(running, firstExit.child);
    const remainingExitCodes = await Promise.all(exitPromises);
    const failed = [firstExit.code, ...remainingExitCodes].find(code => code !== 0);
    if (typeof failed === "number" && failed !== 0) {
      process.exitCode = failed;
    }
  } finally {
    process.off("SIGINT", forwardSignal);
    process.off("SIGTERM", forwardSignal);
  }
}

function startTargetProcess(outDir: string, target: RunTarget, dev: boolean): ChildProcess {
  if (target === "frontend") {
    const child = spawn("npm", ["start"], {
      cwd: path.join(outDir, "frontend"),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    attachPrefixedOutput(child, "frontend");
    return child;
  }

  const backendDir = path.join(outDir, "backend");
  const child = spawn(
    "python3",
    dev
      ? ["-m", "flask", "--app", "app", "run", "--debug"]
      : ["app.py"],
    {
      cwd: backendDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  attachPrefixedOutput(child, "backend");
  return child;
}

function attachPrefixedOutput(
  child: ReturnType<typeof spawn>,
  label: string
): void {
  child.stdout?.on("data", chunk => writePrefixedOutput(label, String(chunk)));
  child.stderr?.on("data", chunk => writePrefixedOutput(label, String(chunk)));
}

function writePrefixedOutput(label: string, text: string): void {
  const prefix = `[${label}] `;
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length === 0 && index === lines.length - 1) {
      continue;
    }
    process.stdout.write(`${prefix}${line}\n`);
  }
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", code => {
      resolve(code ?? 0);
    });
  });
}

function waitForFirstExit(
  children: ChildProcess[],
  exitPromises: Promise<number>[]
): Promise<{ child: ChildProcess; code: number }> {
  return Promise.race(
    children.map((child, index) =>
      exitPromises[index].then(code => ({ child, code }))
    )
  );
}

function terminateOtherProcesses(children: ChildProcess[], exitedChild: ChildProcess): void {
  for (const child of children) {
    if (child === exitedChild || child.killed) {
      continue;
    }
    child.kill("SIGTERM");
  }
}

async function runForegroundCommand(
  command: string,
  args: string[],
  cwd: string,
  label: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    attachPrefixedOutput(child, label);

    child.on("error", reject);
    child.on("exit", code => {
      if ((code ?? 0) === 0) {
        resolve();
        return;
      }

      reject(new Error(`${label} failed with exit code ${code ?? 1}`));
    });
  });
}

function stringFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function resolveRuntimeAddresses(
  outDir: string,
  targets: RunTarget[],
  dev: boolean
): Promise<RuntimeAddresses> {
  const result: RuntimeAddresses = {};

  if (targets.includes("frontend")) {
    result.frontendUrl = "http://localhost:3000";
  }

  if (targets.includes("backend")) {
    const backendDir = path.join(outDir, "backend");
    const backendPort = await detectBackendPort(backendDir, dev);
    result.backendUrl = `http://localhost:${backendPort}`;
    result.mongoUri = await detectMongoUri(backendDir);
  }

  return result;
}

async function detectBackendPort(backendDir: string, dev: boolean): Promise<number> {
  const appPath = path.join(backendDir, "app.py");
  if (await fileExists(appPath)) {
    const content = await readTextFile(appPath);
    const portMatch = content.match(/app\.run\s*\(\s*port\s*=\s*(\d+)/);
    if (portMatch) {
      return Number(portMatch[1]);
    }
  }

  return dev ? 5000 : 5000;
}

async function detectMongoUri(backendDir: string): Promise<string | undefined> {
  const envPath = path.join(backendDir, ".env");
  if (await fileExists(envPath)) {
    const envContent = await readTextFile(envPath);
    const envMatch = envContent.match(/^MONGO_URI=(.+)$/m);
    if (envMatch) {
      return envMatch[1].trim();
    }
  }

  const appPath = path.join(backendDir, "app.py");
  if (await fileExists(appPath)) {
    const content = await readTextFile(appPath);
    const codeMatch = content.match(/MONGO_URI"\]\s*=\s*"([^"]+)"/);
    if (codeMatch) {
      return codeMatch[1];
    }
  }

  return undefined;
}

function printRuntimeAddresses(
  addresses: RuntimeAddresses,
  targets: RunTarget[],
  dev: boolean
): void {
  const mode = dev ? "dev" : "run";
  console.log(`spec ${mode} targets: ${targets.join(", ")}`);

  if (addresses.frontendUrl) {
    console.log(`frontend url: ${addresses.frontendUrl}`);
  }

  if (addresses.backendUrl) {
    console.log(`backend url: ${addresses.backendUrl}`);
  }

  if (addresses.mongoUri) {
    console.log(`mongodb uri: ${addresses.mongoUri}`);
  }
}

async function checkMongoConnectivity(mongoUri: string | undefined): Promise<void> {
  if (!mongoUri) {
    console.warn("warning: MongoDB URI not found. Skipping connectivity check.");
    return;
  }

  const endpoint = parseMongoEndpoint(mongoUri);
  if (!endpoint) {
    console.warn("warning: Could not parse MongoDB host/port from URI. Skipping connectivity check.");
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(endpoint.port, endpoint.host);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(`MongoDB is not reachable at ${endpoint.host}:${endpoint.port}`)
      );
    }, 3000);

    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.end();
      console.log(`mongodb reachable: ${endpoint.host}:${endpoint.port}`);
      resolve();
    });

    socket.once("error", error => {
      clearTimeout(timeout);
      reject(
        new Error(
          `MongoDB connectivity check failed for ${endpoint.host}:${endpoint.port}: ${error.message}`
        )
      );
    });
  });
}

function parseMongoEndpoint(
  mongoUri: string
): { host: string; port: number } | undefined {
  const normalized = mongoUri.replace(/^mongodb(\+srv)?:\/\//, "");
  const authority = normalized.split("/")[0];
  const hostPart = authority.split(",")[0]?.split("@").pop();

  if (!hostPart) {
    return undefined;
  }

  const [host, portText] = hostPart.split(":");
  if (!host) {
    return undefined;
  }

  return {
    host,
    port: portText && Number.isFinite(Number(portText)) ? Number(portText) : 27017
  };
}
