import path from "node:path";
import net from "node:net";
import { existsSync } from "node:fs";
import { ChildProcess, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileExists, readTextFile } from "../utils/fs.js";
import { createLogger } from "../utils/logger.js";

export type RuntimeTarget = "frontend" | "backend";

export type RuntimeFailure = {
  target: RuntimeTarget;
  stage: "install" | "build" | "start" | "probe";
  summary: string;
  command: string;
  output: string;
};

export async function runRuntimeValidation(input: {
  outDir: string;
  targets: RuntimeTarget[];
  logger: ReturnType<typeof createLogger>;
  debug: boolean;
}): Promise<{ success: boolean; failures: RuntimeFailure[] }> {
  const failures: RuntimeFailure[] = [];

  if (input.targets.includes("frontend")) {
    const frontendDir = path.join(input.outDir, "frontend");
    const frontendInstall = await runCapturedCommand({
      command: "npm",
      args: ["install"],
      cwd: frontendDir
    });

    if (!frontendInstall.ok) {
      failures.push({
        target: "frontend",
        stage: "install",
        summary: "frontend dependency installation failed",
        command: formatCommand("npm", ["install"]),
        output: frontendInstall.output
      });
    } else {
      input.logger.debug(input.debug, "runtime frontend install", truncateOutput(frontendInstall.output));

      const frontendBuild = await runCapturedCommand({
        command: "npm",
        args: ["run", "build"],
        cwd: frontendDir
      });

      if (!frontendBuild.ok) {
        failures.push({
          target: "frontend",
          stage: "build",
          summary: "frontend build failed",
          command: formatCommand("npm", ["run", "build"]),
          output: frontendBuild.output
        });
      } else {
        input.logger.debug(input.debug, "runtime frontend build", truncateOutput(frontendBuild.output));
        try {
          const runtime = await resolveFrontendRuntime(frontendDir);
          const frontendStart = await runLongLivedCommandCheck({
            command: "npm",
            args: runtime.args,
            cwd: frontendDir,
            env: runtime.env,
            port: runtime.port,
            probeUrl: `http://127.0.0.1:${runtime.port}/`,
            startupTimeoutMs: 20000
          });

          if (!frontendStart.ok) {
            failures.push({
              target: "frontend",
              stage: frontendStart.stage,
              summary: frontendStart.summary,
              command: formatCommand("npm", runtime.args),
              output: frontendStart.output
            });
          } else {
            input.logger.debug(
              input.debug,
              "runtime frontend start",
              truncateOutput(frontendStart.output)
            );
          }
        } catch (error) {
          failures.push({
            target: "frontend",
            stage: "start",
            summary: "frontend runtime configuration could not be resolved",
            command: formatCommand("npm", ["start"]),
            output: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  }

  if (input.targets.includes("backend")) {
    const backendDir = path.join(input.outDir, "backend");
    let backendPython: string;
    try {
      backendPython = await ensureBackendVirtualEnv(backendDir);
    } catch (error) {
      failures.push({
        target: "backend",
        stage: "install",
        summary: "backend virtual environment setup failed",
        command: "python3 -m venv .venv",
        output: error instanceof Error ? error.message : String(error)
      });
      return {
        success: false,
        failures
      };
    }
    const requirementsPath = path.join(backendDir, "requirements.txt");

    if (await fileExists(requirementsPath)) {
      const backendInstall = await runCapturedCommand({
        command: backendPython,
        args: ["-m", "pip", "install", "-r", "requirements.txt"],
        cwd: backendDir
      });

      if (!backendInstall.ok) {
        failures.push({
          target: "backend",
          stage: "install",
          summary: "backend dependency installation failed",
          command: formatCommand(backendPython, ["-m", "pip", "install", "-r", "requirements.txt"]),
          output: backendInstall.output
        });
      } else {
        input.logger.debug(input.debug, "runtime backend install", truncateOutput(backendInstall.output));
      }
    }

    const backendPort = await detectBackendPort(backendDir);
    const backendStart = await runLongLivedCommandCheck({
      command: backendPython,
      args: [
        "-c",
        [
          "from app import app",
          `app.run(host='127.0.0.1', port=${backendPort}, debug=False, use_reloader=False)`
        ].join("; ")
      ],
      cwd: backendDir,
      env: process.env,
      port: backendPort,
      probeUrl: `http://127.0.0.1:${backendPort}/`,
      startupTimeoutMs: 15000
    });

    if (!backendStart.ok) {
      failures.push({
        target: "backend",
        stage: backendStart.stage,
        summary: backendStart.summary,
        command: formatCommand(backendPython, [
          "-c",
          `from app import app; app.run(host='127.0.0.1', port=${backendPort}, debug=False, use_reloader=False)`
        ]),
        output: backendStart.output
      });
    } else {
      input.logger.debug(input.debug, "runtime backend start", truncateOutput(backendStart.output));
    }
  }

  return {
    success: failures.length === 0,
    failures
  };
}

type CapturedCommandResult = {
  ok: boolean;
  output: string;
};

async function runCapturedCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CapturedCommandResult> {
  return new Promise(resolve => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    child.stdout?.on("data", chunk => {
      output = appendOutput(output, String(chunk));
    });
    child.stderr?.on("data", chunk => {
      output = appendOutput(output, String(chunk));
    });

    child.on("error", error => {
      output = appendOutput(output, String(error));
      resolve({
        ok: false,
        output
      });
    });

    child.on("exit", code => {
      resolve({
        ok: (code ?? 0) === 0,
        output
      });
    });
  });
}

async function runLongLivedCommandCheck(input: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  port: number;
  probeUrl: string;
  startupTimeoutMs: number;
}): Promise<{
  ok: boolean;
  stage: "start" | "probe";
  summary: string;
  output: string;
}> {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  let spawnError: string | undefined;
  child.stdout?.on("data", chunk => {
    output = appendOutput(output, String(chunk));
  });
  child.stderr?.on("data", chunk => {
    output = appendOutput(output, String(chunk));
  });
  child.on("error", error => {
    spawnError = error instanceof Error ? error.message : String(error);
    output = appendOutput(output, spawnError);
  });

  try {
    const startResult = await waitForStartup(child, input.port, input.startupTimeoutMs, () => output);
    if (!startResult.ok) {
      return {
        ok: false,
        stage: "start",
        summary: spawnError ? `process failed to launch: ${spawnError}` : startResult.summary,
        output
      };
    }

    const probeResult = await probeHttpUrl(input.probeUrl);
    if (!probeResult.ok) {
      return {
        ok: false,
        stage: "probe",
        summary: `service started but HTTP probe failed for ${input.probeUrl}`,
        output: appendOutput(output, probeResult.output)
      };
    }

    await delay(500);
    return {
      ok: true,
      stage: "start",
      summary: "service started successfully",
      output
    };
  } finally {
    await stopChildProcess(child);
  }
}

async function waitForStartup(
  child: ChildProcess,
  port: number,
  timeoutMs: number,
  getOutput: () => string
): Promise<{ ok: boolean; summary: string }> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const exitCode = child.exitCode;
    if (typeof exitCode === "number") {
      return {
        ok: false,
        summary: `process exited before startup completed with code ${exitCode}`
      };
    }

    if (await canConnectToPort(port)) {
      return {
        ok: true,
        summary: "service is accepting connections"
      };
    }

    const output = getOutput();
    if (/\b(?:SyntaxError|TypeError|ReferenceError|ImportError|ModuleNotFoundError|Traceback|ERR!|Error:)\b/.test(output)) {
      return {
        ok: false,
        summary: "process emitted a startup error before becoming ready"
      };
    }

    await delay(250);
  }

  return {
    ok: false,
    summary: `process did not become ready on port ${port} within ${timeoutMs}ms`
  };
}

async function probeHttpUrl(url: string): Promise<{ ok: boolean; output: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      signal: controller.signal
    });

    return {
      ok: response.status < 500,
      output: `HTTP ${response.status} ${response.statusText}`.trim()
    };
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.killed || child.exitCode !== null) {
    return;
  }

  child.kill("SIGINT");
  const stopped = await waitForExit(child, 5000);
  if (stopped) {
    return;
  }

  child.kill("SIGTERM");
  await waitForExit(child, 5000);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) {
    return true;
  }

  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const onExit = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onExit);
    };

    child.once("exit", onExit);
    child.once("error", onExit);
  });
}

async function canConnectToPort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port
    });

    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(1000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function resolveFrontendRuntime(frontendDir: string): Promise<{
  args: string[];
  env: NodeJS.ProcessEnv;
  port: number;
}> {
  const manifest = await readPackageManifest(path.join(frontendDir, "package.json"));
  const scripts = manifest.scripts ?? {};
  const env = buildFrontendRuntimeEnv(manifest);

  if (typeof scripts.start === "string" && scripts.start.trim().length > 0) {
    return {
      args: ["start"],
      env,
      port: extractPortFromScript(scripts.start) ?? 3000
    };
  }

  if (typeof scripts.dev === "string" && scripts.dev.trim().length > 0) {
    return {
      args: ["run", "dev", "--", "--host", "0.0.0.0", "--port", "3000"],
      env,
      port: extractPortFromScript(scripts.dev) ?? 3000
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

async function ensureBackendVirtualEnv(backendDir: string): Promise<string> {
  const backendPython = resolveBackendPythonCommand(backendDir);
  if (backendPython !== "python3") {
    return backendPython;
  }

  const createVenv = await runCapturedCommand({
    command: "python3",
    args: ["-m", "venv", ".venv"],
    cwd: backendDir
  });
  if (!createVenv.ok) {
    throw new Error(`Failed to create backend virtual environment: ${createVenv.output}`);
  }

  return resolveBackendPythonCommand(backendDir);
}

function resolveBackendPythonCommand(backendDir: string): string {
  const virtualEnvPython = path.join(backendDir, ".venv", "bin", "python");
  return existsSync(virtualEnvPython) ? virtualEnvPython : "python3";
}

async function detectBackendPort(backendDir: string): Promise<number> {
  const appPath = path.join(backendDir, "app.py");
  if (!(await fileExists(appPath))) {
    return 5000;
  }

  const content = await readTextFile(appPath);
  const portMatch = content.match(/app\.run\s*\([\s\S]*?port\s*=\s*(\d+)/);
  return portMatch ? Number(portMatch[1]) : 5000;
}

function extractPortFromScript(script: string): number | undefined {
  const match = script.match(/--port\s+(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function appendOutput(existing: string, chunk: string, maxLength = 12000): string {
  const next = `${existing}${chunk}`;
  if (next.length <= maxLength) {
    return next;
  }

  return next.slice(next.length - maxLength);
}

function truncateOutput(output: string, maxLength = 4000): string {
  if (output.length <= maxLength) {
    return output;
  }

  return `${output.slice(output.length - maxLength)}`;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

type PackageManifest = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
