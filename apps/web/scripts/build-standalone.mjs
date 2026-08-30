import { spawn } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const appRoot = process.cwd();
const isRepositoryApp =
  path.basename(appRoot).toLowerCase() === "web" &&
  path.basename(path.dirname(appRoot)).toLowerCase() === "apps";
const workspaceRoot = isRepositoryApp ? path.resolve(appRoot, "../..") : appRoot;
const nodeOptions = process.env.NODE_OPTIONS?.trim();
const child = spawn(
  process.execPath,
  [path.join(appRoot, "node_modules", "next", "dist", "bin", "next"), "build", "--webpack"],
  {
    cwd: appRoot,
    env: {
      ...process.env,
      NODE_PATH: path.join(appRoot, "node_modules"),
      NODE_OPTIONS: nodeOptions
        ? `${nodeOptions} --max-old-space-size=1024`
        : "--max-old-space-size=1024",
    },
    stdio: "inherit",
  },
);

const result = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

if (result.signal) process.kill(process.pid, result.signal);
if (result.code !== 0) process.exit(result.code ?? 1);

// Next's Windows standalone tracer can omit dynamically required files when
// `.next` points through a cross-drive junction. Copying the installed Next
// package is deterministic and also makes the Docker artifact self-contained.
const runtimeRoot = path.join(
  appRoot,
  ".next",
  "standalone",
  path.relative(workspaceRoot, appRoot),
);
const runtimeModules = path.join(runtimeRoot, "node_modules");
await mkdir(runtimeModules, { recursive: true });
await cp(
  path.join(appRoot, "node_modules", "next"),
  path.join(runtimeModules, "next"),
  { recursive: true, force: true },
);
