import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;

const appRoot = process.cwd();
const projectRoot = path.resolve(appRoot, "../..");
loadEnvConfig(projectRoot, false);
const standaloneRoot = path.join(appRoot, ".next", "standalone");
const runtimeRoot = path.join(standaloneRoot, path.relative(projectRoot, appRoot));
const serverPath = path.join(runtimeRoot, "server.js");
const localMode = process.argv.includes("--local");
const port = argumentValue("--port") ?? process.env.PORT ?? (localMode ? "3001" : "3000");
const hostname = argumentValue("--host") ?? process.env.HOSTNAME ?? "127.0.0.1";

await requireFile(serverPath, "Run `npm run build` before starting the production server.");
await copyRuntimeAssets();

const environment = {
  ...process.env,
  PORT: port,
  HOSTNAME: hostname,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? `http://localhost:${port}`,
};

if (localMode) {
  environment.LOCAL_MODE = "true";
  environment.LOCAL_STORE_PATH = process.env.LOCAL_STORE_PATH ?? path.join(appRoot, ".xyn", "local-store.json");
  environment.LLM_PROVIDER = process.env.LLM_PROVIDER ?? "mrie";
  environment.STT_PROVIDER = process.env.STT_PROVIDER ?? "browser";
  environment.TTS_PROVIDER = process.env.TTS_PROVIDER ?? "browser";
  environment.AUTH_SECRET = await localAuthSecret();
}

let mrieChild;
if (localMode) {
  const mrieHost = environment.MRIE_RPC_HOST ?? "127.0.0.1";
  const mriePort = Number(environment.MRIE_RPC_PORT ?? "17351");
  if (!(await tcpAvailable(mrieHost, mriePort))) {
    mrieChild = spawn(environment.MRIE_PYTHON ?? "python", ["-m", "mrie", "serve"], {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    await waitForTcp(mrieHost, mriePort, mrieChild);
  }
}

const child = spawn(process.execPath, [serverPath], {
  cwd: appRoot,
  env: environment,
  stdio: "inherit",
  windowsHide: false,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
    mrieChild?.kill(signal);
  });
}

child.once("error", (error) => {
  console.error(`MRE dashboard could not start: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  mrieChild?.kill();
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function requireFile(filePath, message) {
  try {
    if (!(await stat(filePath)).isFile()) throw new Error(message);
  } catch {
    throw new Error(message);
  }
}

async function copyRuntimeAssets() {
  await mkdir(path.join(runtimeRoot, ".next"), { recursive: true });
  await cp(path.join(appRoot, ".next", "static"), path.join(runtimeRoot, ".next", "static"), {
    recursive: true,
    force: true,
  });
  await cp(path.join(appRoot, "public"), path.join(runtimeRoot, "public"), {
    recursive: true,
    force: true,
  });
  await cp(path.join(appRoot, "node_modules", "next"), path.join(runtimeRoot, "node_modules", "next"), {
    recursive: true,
    force: true,
  });
}

async function localAuthSecret() {
  const stateDirectory = path.join(appRoot, ".xyn");
  const secretPath = path.join(stateDirectory, "local-auth-secret");
  await mkdir(stateDirectory, { recursive: true });
  try {
    const existing = (await readFile(secretPath, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // First local start; create a stable per-workspace secret below.
  }
  const secret = randomBytes(48).toString("base64url");
  await writeFile(secretPath, secret, { encoding: "utf8", mode: 0o600 });
  return secret;
}

function tcpAvailable(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (available) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForTcp(host, port, processHandle, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`MRE exited before its IPC service was ready (code ${processHandle.exitCode}).`);
    }
    if (await tcpAvailable(host, port)) return;
    await delay(250);
  }
  processHandle.kill();
  throw new Error(`MRE did not open ${host}:${port} within ${timeoutMs / 1_000} seconds.`);
}
