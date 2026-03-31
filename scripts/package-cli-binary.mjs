#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const seaDir = path.join(rootDir, ".sea");
const outDir = path.join(rootDir, "artifacts", "cli");
const bundlePath = path.join(seaDir, "ag-bridge-cli.cjs");
const configPath = path.join(seaDir, "sea-config.json");
const blobPath = path.join(seaDir, "ag-bridge-cli.blob");
const exeExt = process.platform === "win32" ? ".exe" : "";
const binaryName = `ag-bridge-cli-${process.platform}-${process.arch}${exeExt}`;
const binaryPath = path.join(outDir, binaryName);
const postjectBin = path.join(
  rootDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "postject.cmd" : "postject",
);
const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

await rm(seaDir, { recursive: true, force: true });
await mkdir(seaDir, { recursive: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, "src", "cli.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: [`node${process.versions.node.split(".")[0]}`],
  outfile: bundlePath,
  banner: {
    js: "#!/usr/bin/env node",
  },
  plugins: [
    {
      name: "prefer-local-ts-sources",
      setup(buildContext) {
        buildContext.onResolve({ filter: /\.js$/ }, (args) => {
          if (!args.resolveDir || !args.path.startsWith(".")) {
            return null;
          }

          const jsPath = path.resolve(args.resolveDir, args.path);
          if (!jsPath.startsWith(rootDir)) {
            return null;
          }

          const tsPath = jsPath.replace(/\.js$/, ".ts");
          if (!existsSync(tsPath)) {
            return null;
          }

          return { path: tsPath };
        });
      },
    },
  ],
});

await writeFile(
  configPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);

run(process.execPath, ["--experimental-sea-config", configPath], "Failed to create the SEA blob.");
await rm(binaryPath, { force: true });
await copyFile(process.execPath, binaryPath);
await chmod(binaryPath, 0o755);

if (process.platform === "darwin") {
  run("codesign", ["--remove-signature", binaryPath], "Failed to remove the existing code signature.");
}

const postjectArgs = [
  binaryPath,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  seaFuse,
];
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
run(postjectBin, postjectArgs, "Failed to inject the SEA blob into the Node executable.");

if (process.platform === "darwin") {
  run("codesign", ["--sign", "-", binaryPath], "Failed to ad-hoc sign the generated binary.");
}

await chmod(binaryPath, 0o755);

console.log(`Built CLI binary: ${binaryPath}`);

function run(command, args, failureMessage) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(failureMessage);
  }
}
