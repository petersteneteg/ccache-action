import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import * as core from "@actions/core";
import * as io from "@actions/io";
import * as exec from "@actions/exec";
import * as process from "process";
import * as cache from "@actions/cache";
import { cacheDir } from "./common";

const SELF_CI = process.env["CCACHE_ACTION_CI"] === "true"

// based on https://cristianadam.eu/20200113/speeding-up-c-plus-plus-github-actions-using-ccache/

async function restore(ccacheVariant : string) : Promise<void> {
  const inputs = {
    primaryKey: core.getInput("key"),
    // https://github.com/actions/cache/blob/73cb7e04054996a98d39095c0b7821a73fb5b3ea/src/utils/actionUtils.ts#L56
    restoreKeys: core.getInput("restore-keys").split("\n").map(s => s.trim()).filter(x => x !== ""),
    appendTimestamp: core.getInput("append-timestamp")
  };

  const keyPrefix = ccacheVariant + "-";
  const primaryKey = inputs.primaryKey ? keyPrefix + (inputs.appendTimestamp ? inputs.primaryKey + "-" : inputs.primaryKey) : keyPrefix;
  const restoreKeys = inputs.restoreKeys.map(k => keyPrefix + k + (inputs.appendTimestamp ? "-" : ""));
  const paths = [cacheDir(ccacheVariant)];
  
  core.saveState("primaryKey", primaryKey);

  const shouldRestore = core.getBooleanInput("restore");
  if (!shouldRestore) {
    core.info("Restore set to false, skip restoring cache.");
    return;
  }
  const restoredWith = await cache.restoreCache(paths, primaryKey, restoreKeys);
  if (restoredWith) {
    core.info(`Restored from cache key "${restoredWith}".`);
    if (SELF_CI) {
      core.setOutput("test-cache-hit", true)
    }
  } else {
    core.info("No cache found.");
    if (SELF_CI) {
      core.setOutput("test-cache-hit", false)
    }
  }
}

async function configure(ccacheVariant : string, ccachePath:string, platform : string) : Promise<void> {
  const maxSize = core.getInput('max-size');
  
  if (ccacheVariant === "ccache") {
    await execShell(`'${ccachePath}' --set-config=cache_dir='${cacheDir(ccacheVariant)}'`);
    await execShell(`'${ccachePath}' --set-config=max_size='${maxSize}'`);
    await execShell(`'${ccachePath}' --set-config=compression=true`);
    if (platform === "darwin") {
      await execShell(`${ccachePath} --set-config=compiler_check=content`);
    }
    if (core.getBooleanInput("create-symlink")) {
      await execShell(`ln -s ${ccachePath} /usr/local/bin/gcc`);
      await execShell(`ln -s ${ccachePath} /usr/local/bin/g++`);
      await execShell(`ln -s ${ccachePath} /usr/local/bin/cc`);
      await execShell(`ln -s ${ccachePath} /usr/local/bin/c++`);
      await execShell(`ln -s ${ccachePath} /usr/local/bin/clang`);
      await execShell(`ln -s ${ccachePath} /usr/local/bin/clang++`);
      await execShell(`ln -s ${ccachePath} /usr/local/bin/emcc`);
      await execShell(`ln -s ${ccachePath} /usr/local/bin/em++`);
    }
    core.info("Cccache config:");
    await execShell(`${ccachePath} -p`);
  } else {
    const options = `SCCACHE_IDLE_TIMEOUT=0 SCCACHE_DIR='${cacheDir(ccacheVariant)}' SCCACHE_CACHE_SIZE='${maxSize}'`;
    await execShell(`env ${options} ${ccachePath} --start-server`);
  }

}

async function installCcacheMac() : Promise<string> {
  await execShell("brew install ccache");
  return await io.which("ccache", true);
}

async function installCcacheLinux() : Promise<string> {
  if(process.arch == 'x64') {
    await installCcacheFromGitHub(
      "4.11.3",
      "linux-x86_64",
      "tar.xz",
      // sha256sum of ccache
      "850c37237f086aa4f2d282b7e3bece2b6c5c306f709c13ea7407ba6bfd06b45d",
      "/usr/local/bin",
      "ccache"
    );
    return "/usr/local/bin/ccache"
  } else {
    if (await io.which("apt-get")) {
      await execShellSudo("apt-get install -y ccache");
      return await io.which("ccache", true);
    } else if (await io.which("apk")) {
      await execShell("apk add ccache");
      return await io.which("ccache", true);
    }
    throw Error("Can't install ccache automatically under this platform, please install it yourself before using this action.");
  }
}

async function installCcacheWindows() : Promise<string> {
  // TODO find a better place
  const dir:string = `${core.toPosixPath(process.env.USERPROFILE ?? "")}/.cargo/bin`
  await installCcacheFromGitHub(
    "4.11.3",
    "windows-x86_64",
    "zip",
    // sha256sum of ccache.exe
    "e67407fc24a1ef04bb0368a2d63004879cbd46ae157ca75eec94ae5bddc5fb91",
    dir,
    "ccache.exe"
  );
  return `${dir}/ccache.exe`
}

async function installSccacheMac() : Promise<string> {
  await execShell("brew install sccache");
  return await io.which("sccache", true);
}

async function installSccacheLinux() : Promise<string> {
  let packageName: string;
  let sha256: string;
  switch (process.arch) {
    case "x64":
      packageName = "x86_64-unknown-linux-musl";
      sha256 = "c205ba0911ce383e90263df8d83e445becccfff1bc0bb2e69ec57d1aa3090a4b";
      break;
    case "arm64":
      packageName = "aarch64-unknown-linux-musl";
      sha256 = "8df5d557b50aa19c1c818b1a6465454a9dd807917af678f3feae11ee5c9dbe27"
      break;
    default:
      throw new Error(`Unsupported architecture: ${process.arch}`);
  }
  await installSccacheFromGitHub(
    "v0.10.0",
    packageName,
    sha256,
    "/usr/local/bin",
    "sccache"
  );
  return "/usr/local/bin/sccache"
}

async function installSccacheWindows() : Promise<string> {
  // TODO find a better place
  const dir = `${core.toPosixPath(process.env.USERPROFILE ?? "")}/.cargo/bin`
  await installSccacheFromGitHub(
    "v0.10.0",
    "x86_64-pc-windows-msvc",
    "f3eff6014d973578498dbabcf1510fec2a624043d4035e15f2dc660fb35200d7",
    dir,
    "sccache.exe"
  );
  return `${dir}/sccache.exe`
}

async function execShell(cmd : string) {
  await exec.exec("sh", ["-xc", cmd]);
}

async function execShellSudo(cmd : string) {
  await execShell("$(which sudo) " + cmd);
}

async function installCcacheFromGitHub(version : string, artifactName : string, ext: string, binSha256 : string, binDir : string, binName : string) : Promise<void> {
  const archiveName = `ccache-${version}-${artifactName}`;
  const url = `https://github.com/ccache/ccache/releases/download/v${version}/${archiveName}.${ext}`;
  const binPath = path.join(binDir, binName);
  await downloadAndExtract(url, path.join(archiveName, binName), binPath);
  checkSha256Sum(binPath, binSha256);
  core.addPath(binDir);
}

async function installSccacheFromGitHub(version : string, artifactName : string, binSha256 : string, binDir : string, binName : string) : Promise<void> {
  const archiveName = `sccache-${version}-${artifactName}`;
  const url = `https://github.com/mozilla/sccache/releases/download/${version}/${archiveName}.tar.gz`;
  const binPath = path.join(binDir, binName);
  await downloadAndExtract(url, `*/${binName}`, binPath);
  checkSha256Sum(binPath, binSha256);
  core.addPath(binDir);
  await execShell(`chmod +x '${binPath}'`);
}

async function downloadAndExtract (url : string, srcFile : string, dstFile : string) {
  const dstDir = path.dirname(dstFile);
  if (!fs.existsSync(dstDir)) {
    fs.mkdirSync(dstDir, { recursive: true });
  }

  if (url.endsWith(".zip")) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), ""));
    const zipName = path.join(tmp, "dl.zip");
    await execShell(`curl -L '${url}' -o '${zipName}'`);
    await execShell(`unzip '${zipName}' -d '${tmp}'`);
    fs.copyFileSync(path.join(tmp, srcFile), dstFile);
    fs.rmSync(tmp, { recursive: true });
  } else if (url.endsWith(".tar.xz")) {
    await execShellSudo(`curl -L '${url}' | tar xfJ - -O '${srcFile}' > '${dstFile}'`);
    await execShellSudo(`chmod a+x '${dstFile}'`)
  } else {
    await execShell(`curl -L '${url}' | tar xzf - -O --wildcards '${srcFile}' > '${dstFile}'`);
  }
}

function checkSha256Sum (path : string, expectedSha256 : string) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(path));
  const actualSha256 = h.digest("hex");
  if (actualSha256  !== expectedSha256) {
    throw Error(`SHA256 of ${path} is ${actualSha256}, expected ${expectedSha256}`);
  }
}

async function runInner() : Promise<void> {
  const ccacheVariant = core.getInput("variant");
  core.saveState("startTimestamp", Date.now());
  core.saveState("ccacheVariant", ccacheVariant);
  core.saveState("evictOldFiles", core.getInput("evict-old-files"));
  core.saveState("shouldSave", core.getBooleanInput("save"));
  core.saveState("appendTimestamp", core.getBooleanInput("append-timestamp"));
  let ccachePath = await io.which(ccacheVariant);
  if (!ccachePath) {
    core.startGroup(`Install ${ccacheVariant}`);
    const installer = {
      ["ccache,linux"]: installCcacheLinux,
      ["ccache,darwin"]: installCcacheMac,
      ["ccache,win32"]: installCcacheWindows,
      ["sccache,linux"]: installSccacheLinux,
      ["sccache,darwin"]: installSccacheMac,
      ["sccache,win32"]: installSccacheWindows,
    }[[ccacheVariant, process.platform].join()];
    if (!installer) {
      throw Error(`Unsupported platform: ${process.platform}`)
    }
    ccachePath = await installer();
    core.info(`Cache executable: ${ccachePath}`);
    core.endGroup();
  }

  // This will fail if we can not find the executable
  await io.which(ccacheVariant, true);

  await execShell(`${ccachePath} --version`);

  core.setOutput("executable", core.toPosixPath(ccachePath));

  core.startGroup("Restore cache");
  await restore(ccacheVariant);
  core.endGroup();

  core.startGroup(`Configure ${ccacheVariant}, ${process.platform}`);
  await configure(ccacheVariant, ccachePath, process.platform);
  await execShell(`${ccachePath} -z`);
  core.endGroup();
}

async function run() : Promise<void> {
  try {
    await runInner();
  } catch (error) {
    core.setFailed(`Restoring cache failed: ${error}`);
  }
}

run();

export default run;
