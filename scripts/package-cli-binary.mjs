#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const seaDir = path.join(rootDir, ".sea");
const cacheDir = path.join(seaDir, "cache");
const outDir = path.join(rootDir, "artifacts", "cli");
const bundlePath = path.join(seaDir, "ag-bridge-cli.cjs");
const configPath = path.join(seaDir, "sea-config.json");
const blobPath = path.join(seaDir, "ag-bridge-cli.blob");
const postjectBin = path.join(
  rootDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "postject.cmd" : "postject",
);
const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const nodeVersion = process.versions.node;
const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
const packageVersion = packageJson.version;
const hostTarget = `${process.platform}-${process.arch}`;
const commonTargets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "win32-x64",
];

const args = process.argv.slice(2);
const requestedTargets = readFlag(args, "--targets")
  ?? readFlag(args, "--target")
  ?? hostTarget;
const targets = requestedTargets === "common"
  ? commonTargets
  : requestedTargets.split(",").map((value) => value.trim()).filter(Boolean);

await rm(seaDir, { recursive: true, force: true });
await mkdir(seaDir, { recursive: true });
await mkdir(cacheDir, { recursive: true });
await mkdir(outDir, { recursive: true });

await buildCliBundle();
await writeSeaConfig();
run(process.execPath, ["--experimental-sea-config", configPath], "Failed to create the SEA blob.");

const outputs = [];
for (const targetSpec of targets) {
  const target = parseTarget(targetSpec);
  const result = await packageTarget(target);
  outputs.push(result);
}

for (const output of outputs) {
  console.log(`Built CLI binary: ${output.binaryPath}`);
  console.log(`Built CLI archive: ${output.archivePath}`);
}

async function buildCliBundle() {
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
          buildContext.onResolve({ filter: /\.js$/ }, (resolveArgs) => {
            if (!resolveArgs.resolveDir || !resolveArgs.path.startsWith(".")) {
              return null;
            }

            const jsPath = path.resolve(resolveArgs.resolveDir, resolveArgs.path);
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
}

async function writeSeaConfig() {
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
}

async function packageTarget(target) {
  const runtimePath = await resolveRuntimeExecutable(target);
  const binaryPath = path.join(outDir, binaryNameFor(target));
  const archivePath = path.join(outDir, archiveNameFor(target));

  await rm(binaryPath, { force: true });
  await rm(archivePath, { force: true });
  await copyFile(runtimePath, binaryPath);

  if (target.platform !== "win32") {
    await chmod(binaryPath, 0o755);
  }

  if (target.platform === "darwin") {
    if (process.platform !== "darwin") {
      throw new Error("darwin targets must be built on macOS so the generated binary can be codesigned.");
    }
    run("codesign", ["--remove-signature", binaryPath], "Failed to remove the existing code signature.");
  }

  const postjectArgs = [
    binaryPath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    seaFuse,
  ];
  if (target.platform === "darwin") {
    postjectArgs.push("--macho-segment-name", "NODE_SEA");
  }
  run(postjectBin, postjectArgs, `Failed to inject the SEA blob into the ${target.id} executable.`);

  if (target.platform === "darwin") {
    run("codesign", ["--sign", "-", binaryPath], "Failed to ad-hoc sign the generated binary.");
  }

  if (target.platform !== "win32") {
    await chmod(binaryPath, 0o755);
  }

  await createArchive(target, binaryPath, archivePath);

  return {
    target: target.id,
    binaryPath,
    archivePath,
  };
}

async function resolveRuntimeExecutable(target) {
  if (target.id === hostTarget) {
    return process.execPath;
  }

  const distInfo = nodeDistributionFor(target);
  const extractDir = path.join(cacheDir, distInfo.folderName);
  const archivePath = path.join(cacheDir, distInfo.archiveName);
  const runtimePath = path.join(
    extractDir,
    distInfo.folderName,
    target.platform === "win32" ? "node.exe" : path.join("bin", "node"),
  );

  if (existsSync(runtimePath)) {
    return runtimePath;
  }

  await mkdir(cacheDir, { recursive: true });
  if (!existsSync(archivePath)) {
    await download(distInfo.url, archivePath);
  }

  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await extractArchive(archivePath, extractDir);

  if (!existsSync(runtimePath)) {
    throw new Error(`Failed to find the Node runtime for ${target.id} after extracting ${distInfo.archiveName}.`);
  }

  if (target.platform !== "win32") {
    await chmod(runtimePath, 0o755);
  }
  return runtimePath;
}

async function download(url, destinationPath) {
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }

    await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath));
    return;
  } catch (error) {
    const fallback = spawnSync(
      "curl",
      ["-fsSL", url, "-o", destinationPath],
      {
        cwd: rootDir,
        stdio: "inherit",
      },
    );
    if (fallback.status === 0) {
      return;
    }

    const directEnv = { ...process.env };
    for (const key of [
      "ALL_PROXY",
      "FTP_PROXY",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "RSYNC_PROXY",
      "all_proxy",
      "ftp_proxy",
      "https_proxy",
      "http_proxy",
      "rsync_proxy",
    ]) {
      delete directEnv[key];
    }
    const directFallback = spawnSync(
      "curl",
      ["-fsSL", url, "-o", destinationPath],
      {
        cwd: rootDir,
        stdio: "inherit",
        env: directEnv,
      },
    );
    if (directFallback.status === 0) {
      return;
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to download ${url}: ${reason}`);
  }
}

async function extractArchive(archivePath, extractDir) {
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      run(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${escapePowerShell(archivePath)}' -DestinationPath '${escapePowerShell(extractDir)}' -Force`,
        ],
        `Failed to extract ${path.basename(archivePath)}.`,
      );
      return;
    }

    run("unzip", ["-q", archivePath, "-d", extractDir], `Failed to extract ${path.basename(archivePath)}.`);
    return;
  }

  run("tar", ["-xzf", archivePath, "-C", extractDir], `Failed to extract ${path.basename(archivePath)}.`);
}

async function createArchive(target, binaryPath, archivePath) {
  if (target.platform === "win32") {
    if (process.platform === "win32") {
      run(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Compress-Archive -LiteralPath '${escapePowerShell(binaryPath)}' -DestinationPath '${escapePowerShell(archivePath)}' -Force`,
        ],
        `Failed to create ${path.basename(archivePath)}.`,
      );
      return;
    }

    run("zip", ["-q", "-j", archivePath, binaryPath], `Failed to create ${path.basename(archivePath)}.`);
    return;
  }

  run("tar", ["-czf", archivePath, "-C", outDir, path.basename(binaryPath)], `Failed to create ${path.basename(archivePath)}.`);
}

function binaryNameFor(target) {
  return `ag-bridge-cli-${target.id}${target.platform === "win32" ? ".exe" : ""}`;
}

function archiveNameFor(target) {
  const baseName = `ag-bridge-cli-${packageVersion}-${target.id}`;
  return target.platform === "win32" ? `${baseName}.zip` : `${baseName}.tar.gz`;
}

function nodeDistributionFor(target) {
  const platformLabel = target.platform === "win32" ? "win" : target.platform;
  const folderName = `node-v${nodeVersion}-${platformLabel}-${target.arch}`;
  const archiveExt = target.platform === "win32" ? "zip" : "tar.gz";
  const archiveName = `${folderName}.${archiveExt}`;
  return {
    folderName,
    archiveName,
    url: `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`,
  };
}

function parseTarget(targetSpec) {
  const [platform, arch] = targetSpec.split("-");
  if (!platform || !arch) {
    throw new Error(`Invalid target "${targetSpec}". Expected format like darwin-arm64 or win32-x64.`);
  }

  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error(`Unsupported platform "${platform}" in target "${targetSpec}".`);
  }

  if (!["x64", "arm64"].includes(arch)) {
    throw new Error(`Unsupported architecture "${arch}" in target "${targetSpec}".`);
  }

  return {
    id: `${platform}-${arch}`,
    platform,
    arch,
  };
}

function readFlag(argv, flagName) {
  const index = argv.indexOf(flagName);
  if (index === -1) {
    return null;
  }
  const nextValue = argv[index + 1];
  if (!nextValue || nextValue.startsWith("--")) {
    throw new Error(`Missing value for ${flagName}.`);
  }
  return nextValue;
}

function escapePowerShell(value) {
  return value.replace(/'/g, "''");
}

function run(command, args, failureMessage) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(failureMessage);
  }
}

process.on("unhandledRejection", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
