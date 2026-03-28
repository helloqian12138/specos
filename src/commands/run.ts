import path from "node:path";
import net from "node:net";
import { existsSync } from "node:fs";
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
type RunningTarget = {
  target: RunTarget;
  child: ChildProcess;
};

type FrontendRuntimeConfig = {
  args: string[];
  env: NodeJS.ProcessEnv;
};

type PackageManifest = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
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
  const debug = parsed.flags.debug === true;

  if (frontendOnly && backendOnly) {
    throw new Error("run cannot use --frontend-only and --backend-only together");
  }

  logRun("Resolving runnable targets", debug);
  const targets = await detectRunTargets(outDir, { frontendOnly, backendOnly });
  if (targets.length === 0) {
    throw new Error(`No runnable frontend or backend project found in ${outDir}`);
  }
  logRun(`Detected targets: ${targets.join(", ")}`, true);

  if (!install && targets.includes("backend") && !(await backendVirtualEnvExists(outDir))) {
    logRun("Backend virtual environment is missing; bootstrapping backend dependencies", true);
    await installDependencies(outDir, ["backend"], debug);
  }

  if (install) {
    logRun("Installing dependencies before startup", true);
    await installDependencies(outDir, targets, debug);
    logRun("Dependency installation finished", true);
  }

  logRun("Resolving runtime addresses", debug);
  const addresses = await resolveRuntimeAddresses(outDir, targets, dev);
  printRuntimeAddresses(addresses, targets, dev);

  if (targets.includes("backend")) {
    logRun("Checking MongoDB connectivity", true);
    await checkMongoConnectivity(addresses.mongoUri, debug);
  }

  await runTargets(outDir, targets, dev, debug);
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

async function installDependencies(
  outDir: string,
  targets: RunTarget[],
  debug: boolean
): Promise<void> {
  for (const target of targets) {
    if (target === "frontend") {
      logRun("Starting frontend dependency install", true);
      await runForegroundCommand(
        "npm",
        ["install"],
        path.join(outDir, "frontend"),
        "frontend:install",
        debug,
        { inheritOutput: true }
      );
      logRun("Frontend dependency install finished", true);
      continue;
    }

    const requirementsPath = path.join(outDir, "backend", "requirements.txt");
    if (await fileExists(requirementsPath)) {
      const backendDir = path.join(outDir, "backend");
      const pythonCommand = await ensureBackendVirtualEnv(backendDir, debug);
      logRun("Starting backend dependency install", true);
      await runForegroundCommand(
        pythonCommand,
        ["-m", "pip", "install", "-r", "requirements.txt"],
        backendDir,
        "backend:install",
        debug
      );
      logRun("Backend dependency install finished", true);
    }
  }
}

async function backendVirtualEnvExists(outDir: string): Promise<boolean> {
  return fileExists(path.join(outDir, "backend", ".venv", "bin", "python"));
}

async function runTargets(
  outDir: string,
  targets: RunTarget[],
  dev: boolean,
  debug: boolean
): Promise<void> {
  logRun(`Starting runtime processes in ${dev ? "dev" : "run"} mode`, true);
  const frontendRuntime = targets.includes("frontend")
    ? await resolveFrontendRuntimeConfig(path.join(outDir, "frontend"))
    : undefined;
  const running = targets.map(target => ({
    target,
    child: startTargetProcess(outDir, target, dev, frontendRuntime)
  }));
  const exitPromises = running.map(entry => waitForExit(entry.child));

  const forwardSignal = (signal: NodeJS.Signals) => {
    for (const entry of running) {
      entry.child.kill(signal);
    }
  };

  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);

  try {
    logRun("Waiting for child processes", true);
    const firstExit = await waitForFirstExit(running, exitPromises);
    logRun(
      `${firstExit.target} exited first with code ${firstExit.code}; shutting down others`,
      true
    );
    terminateOtherProcesses(running, firstExit.child, debug);
    const remainingExitCodes = await Promise.all(exitPromises);
    const failed = [firstExit.code, ...remainingExitCodes].find(code => code !== 0);
    if (typeof failed === "number" && failed !== 0) {
      process.exitCode = failed;
    }
  } finally {
    logRun("Run loop finished", debug);
    process.off("SIGINT", forwardSignal);
    process.off("SIGTERM", forwardSignal);
  }
}

function startTargetProcess(
  outDir: string,
  target: RunTarget,
  dev: boolean,
  frontendRuntime?: FrontendRuntimeConfig
): ChildProcess {
  if (target === "frontend") {
    const frontendDir = path.join(outDir, "frontend");
    const runtime = frontendRuntime ?? { args: ["start"], env: process.env };
    logRun(`Launching frontend with npm ${runtime.args.join(" ")} in ${frontendDir}`, true);
    const child = spawn("npm", runtime.args, {
      cwd: path.join(outDir, "frontend"),
      env: runtime.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    attachPrefixedOutput(child, "frontend");
    return child;
  }

  const backendDir = path.join(outDir, "backend");
  const backendPython = resolveBackendPythonCommand(backendDir);
  logRun(
    `Launching backend with ${
      dev ? `${backendPython} -m flask --app app run --debug` : `${backendPython} app.py`
    } in ${backendDir}`,
    true
  );
  const child = spawn(
    backendPython,
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

async function ensureBackendVirtualEnv(backendDir: string, debug: boolean): Promise<string> {
  const backendPython = resolveBackendPythonCommand(backendDir);
  if (backendPython !== "python3") {
    return backendPython;
  }

  logRun("Creating backend virtual environment in .venv", true);
  await runForegroundCommand(
    "python3",
    ["-m", "venv", ".venv"],
    backendDir,
    "backend:venv",
    debug
  );
  return resolveBackendPythonCommand(backendDir);
}

function resolveBackendPythonCommand(backendDir: string): string {
  const virtualEnvPython = path.join(backendDir, ".venv", "bin", "python");
  return existsSync(virtualEnvPython) ? virtualEnvPython : "python3";
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
  running: RunningTarget[],
  exitPromises: Promise<number>[]
): Promise<{ target: RunTarget; child: ChildProcess; code: number }> {
  return Promise.race(
    running.map((entry, index) =>
      exitPromises[index].then(code => ({ target: entry.target, child: entry.child, code }))
    )
  );
}

async function resolveFrontendRuntimeConfig(frontendDir: string): Promise<FrontendRuntimeConfig> {
  const manifest = await readPackageManifest(path.join(frontendDir, "package.json"));
  const scripts = manifest.scripts ?? {};
  const env = buildFrontendRuntimeEnv(manifest);

  if (typeof scripts.start === "string" && scripts.start.trim().length > 0) {
    return {
      args: ["start"],
      env
    };
  }

  if (typeof scripts.dev === "string" && scripts.dev.trim().length > 0) {
    return {
      args: ["run", "dev", "--", "--host", "0.0.0.0", "--port", "3000"],
      env
    };
  }

  throw new Error(
    `frontend package is missing a runnable script. Expected "start" or "dev" in ${path.join(frontendDir, "package.json")}`
  );
}

async function readPackageManifest(packageJsonPath: string): Promise<PackageManifest> {
  const content = await readTextFile(packageJsonPath);
  return JSON.parse(content) as PackageManifest;
}

function buildFrontendRuntimeEnv(manifest: PackageManifest): NodeJS.ProcessEnv {
  const env = { ...process.env };

  if (!requiresLegacyOpenSsl(manifest)) {
    return env;
  }

  const current = env.NODE_OPTIONS?.trim();
  if (current?.includes("--openssl-legacy-provider")) {
    return env;
  }

  env.NODE_OPTIONS = current ? `${current} --openssl-legacy-provider` : "--openssl-legacy-provider";
  return env;
}

function requiresLegacyOpenSsl(manifest: PackageManifest): boolean {
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies
  };

  const reactScriptsVersion = dependencies["react-scripts"];
  if (reactScriptsVersion && getMajorVersion(reactScriptsVersion) < 5) {
    return true;
  }

  const webpackVersion = dependencies.webpack;
  if (webpackVersion && getMajorVersion(webpackVersion) < 5) {
    return true;
  }

  return false;
}

function getMajorVersion(versionRange: string): number {
  const match = versionRange.match(/(\d+)/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function terminateOtherProcesses(
  running: RunningTarget[],
  exitedChild: ChildProcess,
  debug: boolean
): void {
  for (const entry of running) {
    if (entry.child === exitedChild || entry.child.killed) {
      continue;
    }

    logRun(`Stopping ${entry.target} after peer exit`, debug);

    // SIGINT is gentler for dev servers than SIGTERM and tends to produce fewer noisy shutdown warnings.
    entry.child.kill("SIGINT");
  }
}

async function runForegroundCommand(
  command: string,
  args: string[],
  cwd: string,
  label: string,
  debug: boolean,
  options: {
    inheritOutput?: boolean;
  } = {}
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    logRun(`Running ${label}: ${command} ${args.join(" ")}`, true);
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: options.inheritOutput ? "inherit" : ["ignore", "pipe", "pipe"]
    });

    if (!options.inheritOutput) {
      attachPrefixedOutput(child, label);
    }

    child.on("error", reject);
    child.on("exit", code => {
      if ((code ?? 0) === 0) {
        logRun(`${label} completed successfully`, debug);
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

async function checkMongoConnectivity(
  mongoUri: string | undefined,
  debug: boolean
): Promise<void> {
  if (!mongoUri) {
    console.warn("warning: MongoDB URI not found. Skipping connectivity check.");
    return;
  }

  const endpoint = parseMongoEndpoint(mongoUri);
  if (!endpoint) {
    console.warn("warning: Could not parse MongoDB host/port from URI. Skipping connectivity check.");
    return;
  }

  logRun(`Testing MongoDB TCP connectivity to ${endpoint.host}:${endpoint.port}`, debug);

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

function logRun(message: string, enabled: boolean): void {
  if (!enabled) {
    return;
  }

  console.log(`[run] ${message}`);
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
