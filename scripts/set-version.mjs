import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (!version || !semverPattern.test(version)) {
  console.error("Usage: npm run version:set -- <major.minor.patch>");
  process.exit(1);
}

const packagePath = new URL("../package.json", import.meta.url);
const packageLockPath = new URL("../package-lock.json", import.meta.url);
const cargoManifestPath = new URL("../src-tauri/Cargo.toml", import.meta.url);
const cargoLockPath = new URL("../src-tauri/Cargo.lock", import.meta.url);

const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
packageJson.version = version;
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const packageLock = JSON.parse(readFileSync(packageLockPath, "utf8"));
packageLock.version = version;
if (packageLock.packages?.[""]) {
  packageLock.packages[""].version = version;
}
writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);

const cargoManifest = readFileSync(cargoManifestPath, "utf8");
const cargoManifestVersionPattern = /(\[package\][\s\S]*?^version\s*=\s*")[^"]+(".*$)/m;
if (!cargoManifestVersionPattern.test(cargoManifest)) {
  throw new Error("Could not update the package version in src-tauri/Cargo.toml");
}
const updatedCargoManifest = cargoManifest.replace(cargoManifestVersionPattern, `$1${version}$2`);
writeFileSync(cargoManifestPath, updatedCargoManifest);

const cargoLock = readFileSync(cargoLockPath, "utf8");
const cargoLockVersionPattern = /(\[\[package\]\]\r?\nname = "edgeterm"\r?\nversion = ")[^"]+("\r?\n)/;
if (!cargoLockVersionPattern.test(cargoLock)) {
  throw new Error("Could not update the EdgeTerm version in src-tauri/Cargo.lock");
}
const updatedCargoLock = cargoLock.replace(cargoLockVersionPattern, `$1${version}$2`);
writeFileSync(cargoLockPath, updatedCargoLock);

console.log(`EdgeTerm version set to ${version}`);
