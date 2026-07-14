import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const files = {
  packageJson: resolve(root, "package.json"),
  packageLock: resolve(root, "package-lock.json"),
  cargoToml: resolve(root, "src-tauri/Cargo.toml"),
  cargoLock: resolve(root, "src-tauri/Cargo.lock"),
  libRs: resolve(root, "src-tauri/src/lib.rs"),
  tauriConfig: resolve(root, "src-tauri/tauri.conf.json"),
};

const cargoTomlPackagePattern = /(\[package\]\r?\nname = "zterm"\r?\nversion = ")([^"]+)(")/;
const cargoPackagePattern = /(\[\[package\]\]\r?\nname = "zterm"\r?\nversion = ")([^"]+)(")/;
const rustTestPattern = /(assert_eq!\(env!\("CARGO_PKG_VERSION"\), ")([^"]+)("\);)/;

function replaceExactlyOnce(content, pattern, replacement, file) {
  const matches = [...content.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  if (matches.length !== 1) {
    throw new Error(`${file} must contain exactly one matching version field; found ${matches.length}.`);
  }
  return content.replace(pattern, replacement);
}

async function readVersions() {
  const [packageJson, packageLock, cargoToml, cargoLock, libRs, tauriConfig] = await Promise.all(
    Object.values(files).map((file) => readFile(file, "utf8")),
  );
  const cargoTomlVersion = cargoToml.match(cargoTomlPackagePattern)?.[2];
  const cargoLockVersion = cargoLock.match(cargoPackagePattern)?.[2];
  const rustTestVersion = libRs.match(rustTestPattern)?.[2];

  if (!cargoTomlVersion || !cargoLockVersion || !rustTestVersion) {
    throw new Error("A required Rust version field could not be read.");
  }

  return {
    packageJson: JSON.parse(packageJson).version,
    packageLock: JSON.parse(packageLock).version,
    cargoToml: cargoTomlVersion,
    cargoLock: cargoLockVersion,
    rustTest: rustTestVersion,
    tauriConfig: JSON.parse(tauriConfig).version,
  };
}

function assertConsistent(versions, expected) {
  const values = Object.values(versions);
  const actual = [...new Set(values)];
  if (actual.length !== 1 || (expected && actual[0] !== expected)) {
    throw new Error(`Version mismatch: ${Object.entries(versions).map(([file, version]) => `${file}=${version}`).join(", ")}`);
  }
  return actual[0];
}

async function setVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid version "${version}". Expected a stable SemVer version such as 0.1.4.`);
  }

  assertConsistent(await readVersions());
  const [packageJson, packageLock, cargoToml, cargoLock, libRs, tauriConfig] = await Promise.all(
    Object.values(files).map((file) => readFile(file, "utf8")),
  );
  const updatePackageJsonVersion = (content) => {
    const data = JSON.parse(content);
    data.version = version;
    return `${JSON.stringify(data, null, 2)}\n`;
  };
  const updatePackageLockVersion = (content) => {
    const data = JSON.parse(content);
    data.version = version;
    if (!data.packages?.[""]) {
      throw new Error(`${files.packageLock} is missing its root package entry.`);
    }
    data.packages[""].version = version;
    return `${JSON.stringify(data, null, 2)}\n`;
  };

  await Promise.all([
    writeFile(files.packageJson, updatePackageJsonVersion(packageJson)),
    writeFile(files.packageLock, updatePackageLockVersion(packageLock)),
    writeFile(files.cargoToml, replaceExactlyOnce(cargoToml, cargoTomlPackagePattern, `$1${version}$3`, files.cargoToml)),
    writeFile(files.cargoLock, replaceExactlyOnce(cargoLock, cargoPackagePattern, `$1${version}$3`, files.cargoLock)),
    writeFile(files.libRs, replaceExactlyOnce(libRs, rustTestPattern, `$1${version}$3`, files.libRs)),
    writeFile(files.tauriConfig, updatePackageJsonVersion(tauriConfig)),
  ]);
  assertConsistent(await readVersions(), version);
  console.log(`Updated all release versions to ${version}.`);
}

const [command, version] = process.argv.slice(2);

try {
  if (command === "check" && !version) {
    console.log(`All release versions are ${assertConsistent(await readVersions())}.`);
  } else if (command === "set" && version) {
    await setVersion(version);
  } else {
    throw new Error("Usage: npm run version:check | npm run version:set -- <major.minor.patch>");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
