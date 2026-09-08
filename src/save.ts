import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import * as core from "@actions/core";
import * as cache from "@actions/cache";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import { DefaultArtifactClient } from "@actions/artifact";
import * as common from "./common";
import { AgeUnit } from "./common";


async function ccacheIsEmpty(ccacheVariant: string): Promise<boolean> {
  if (ccacheVariant === "ccache") {
    return !!(await getExecShellOutput("ccache -s")).stdout.match(/files in cache.+\b0\b/)
  } else {
    return !!(await getExecShellOutput("sccache -s")).stdout.match(/Cache size.+\b0 bytes/);
  }
}

async function getVerbosity(verbositySetting: string): Promise<string> {
  switch (verbositySetting) {
    case '0':
      return '';

    case '1':
      return ' -v';

    case '2':
      return ' -vv';

    default:
      core.warning(`Invalid value "${verbositySetting}" of "verbose" option ignored.`);
      return '';
  }
}

function getExecShellOutput(cmd: string): Promise<exec.ExecOutput> {
  return exec.getExecOutput("sh", ["-xc", cmd], { silent: true });
}

/**
 * Get if ccache supports output of stats in JSON format (from 4.10)
 * @param ccacheVariant
 */
async function hasJsonStats(ccacheVariant: string): Promise<boolean> {

  if (ccacheVariant !== "ccache") {
    return false;
  }
  const result = await exec.getExecOutput(`${ccacheVariant} --version`)
  if (result.exitCode != 0) {
    return false
  }
  const version = common.parseCCacheVersion(result.stdout);
  return version != null && version[0] >= 4 && version[1] >= 10;
}

async function uploadSummaryArtifact(baseName: string, data: unknown): Promise<void> {
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccache-summary"));
    const filePath = path.join(tmpDir, "ccache-summary.json");
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

    // Artifact names must be unique within a run, so append a random suffix to support matrix builds.
    const artifactName = `${baseName}-${crypto.randomUUID()}`;
    await new DefaultArtifactClient().uploadArtifact(artifactName, [filePath], tmpDir);
  } catch (error) {
    core.warning(`Could not upload summary artifact: ${error}`);
  }
}



export async function evictOldCachesCall(): Promise<number> {
  const primaryKey = core.getState("primaryKey");
  const token = core.getInput("gh-token");
  if (!token) {
    core.info("No github token provided, cannot list caches");
    return 0;
  }
  if (core.getState("appendTimestamp") != "true") {
    core.info("Evicting old caches is skipped because append-timestamp is not true.");
    return 0;
  }

  const octokit = github.getOctokit(token);

  // Paginate through all results
  const allCaches = await octokit.paginate(
    octokit.rest.actions.getActionsCacheList,
    {
      ...github.context.repo,
      per_page: 100, // max per GitHub API
    }
  );

  const pattern = new RegExp(`^${primaryKey}\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`);

  type CacheInfo = { id: number; key: string };
  const matches: CacheInfo[] = allCaches
    .filter((c: { id?: number; key?: string }): c is CacheInfo =>
      typeof c.id === "number" && typeof c.key === "string" && pattern.test(c.key))
    .map((c: CacheInfo) => ({
      id: c.id, key: c.key
    }));

  core.info(`Total caches: ${allCaches.length}`);
  core.info(`All matches: ${JSON.stringify(matches, null, 2)}`);
  core.info(`Deleting ${matches.length} caches with key matching ${primaryKey}<date>`);

  let deletedCount = 0;
  for (const { id, key } of matches) {
    try {
      await octokit.rest.actions.deleteActionsCacheById({
        ...github.context.repo,
        cache_id: id,
      });
      core.info(`✅ Deleted cache ${id} (${key})`);
      deletedCount++;
    } catch (error) {
      core.error(`❌ Failed to delete cache ${id} (${key}): ${(error as Error).message}`);
    }
  }

  return deletedCount;
}


export async function saveSummary(ccacheVariant: string, saveKey: string | undefined, evictedCount: number) {
  core.startGroup(`summary`);
  const jobSummaryTitle = core.getInput("job-summary");
  const summaryArtifactName = core.getInput("summary-artifact");
  if ((jobSummaryTitle.length !== 0 || summaryArtifactName.length !== 0) && await hasJsonStats(ccacheVariant)) {
    const jsonStats = await exec.getExecOutput(ccacheVariant, ["--print-stats", "--format=json"], { silent: true });
    const stats = JSON.parse(jsonStats.stdout);
    if (stats === undefined) {
      core.warning("Could not parse json stats");
    } else {
      const restoredInfo = core.getState("restoredInfo");
      const savedInfo = saveKey ? saveKey : "no";

      if (jobSummaryTitle.length !== 0) {
        const table = common.buildJobSummaryTable(jsonStats.stdout, {
          restored: restoredInfo,
          evicted: evictedCount,
          saved: savedInfo,
        });
        if (table === null) {
          core.warning("Could not build job summary table");
        } else {
          await core.summary
            .addHeading(jobSummaryTitle)
            .addTable(table)
            .write();
        }
      }

      if (summaryArtifactName.length !== 0) {
        await uploadSummaryArtifact(summaryArtifactName, {
          variant: ccacheVariant,
          restored: restoredInfo,
          evicted: evictedCount,
          saved: savedInfo,
          stats,
        });
      }
    }
  }
  core.endGroup();
}

export async function saveCache(ccacheVariant: string, primaryKey: string): Promise<string | undefined> {
  core.startGroup(`save cache`);
  let saveKey: string | undefined = undefined;
  if (core.getState("shouldSave") !== "true") {
    core.info("Not saving cache because 'save' is set to 'false'.");
    return saveKey;
  }
  if (await ccacheIsEmpty(ccacheVariant)) {
    core.info("Not saving cache because no objects are cached.");
    return saveKey;
  } else {
    saveKey = primaryKey;
    if (core.getState("appendTimestamp") == "true") {
      saveKey += new Date().toISOString();
    } else {
      core.debug("Not appending timestamp because 'append-timestamp' is not set to 'true'.");
    }

    const paths = [common.cacheDir(ccacheVariant)];

    core.info(`Save cache using key "${saveKey}".`);
    await cache.saveCache(paths, saveKey);
  }
  core.endGroup();
  return saveKey
}

export async function evictOldFilesCall(age: number, unit: common.AgeUnit): Promise<void> {
  try {
    await exec.exec(`ccache --evict-older-than ${age}${unit}`);
  }
  catch (error) {
    core.warning(`Error occurred evicting old cache files: ${error}`);
  }
}

export async function evictOldFiles(ccacheVariant: string) {
  core.startGroup(`evict old files`);
  const evictByAge = core.getState("evictOldFiles");
  if (evictByAge && ccacheVariant === "ccache") {
    const [time, unit] = common.parseEvictAgeParameter(evictByAge);
    if (unit === AgeUnit.Job) {
      const duration = common.getJobDurationInSeconds();
      core.debug(`Evicting cache files older than ${duration} seconds`);
      await evictOldFilesCall(duration, common.AgeUnit.Seconds);
    }
    else {
      core.debug(`Evicting cache files older than ${time}${unit}`);
      await evictOldFilesCall(time as number, unit);
    }
  }
  core.endGroup();
}

async function evictOldCaches() {
  core.startGroup(`evict old caches`);
  let evictedCount = 0;
  if (core.getBooleanInput("evict-old-caches")) {
    evictedCount += await evictOldCachesCall();
  } else {
    core.info("Evicting old caches is skipped because 'evict-old-caches' is off.");
  }
  core.endGroup();
  return evictedCount;
}

async function showStatistics(ccacheVariant: string) {
  core.startGroup(`${ccacheVariant} stats`);
  // Some versions of ccache do not support --verbose
  const ccacheKnowsVerbosityFlag = !!(await getExecShellOutput(`${ccacheVariant} --help`)).stdout.includes("--verbose");
  const verbosity = ccacheKnowsVerbosityFlag ? await getVerbosity(core.getInput("verbose")) : '';
  await exec.exec(`${ccacheVariant} -s${verbosity}`);
  core.endGroup();
}

async function run(earlyExit: boolean | undefined): Promise<void> {
  try {
    const ccacheVariant = core.getState("ccacheVariant");
    const primaryKey = core.getState("primaryKey");
    if (!ccacheVariant || !primaryKey) {
      core.notice("ccache setup failed, skipping saving.");
      return;
    }

    await showStatistics(ccacheVariant);
    const evictedCount = await evictOldCaches();
    await evictOldFiles(ccacheVariant);
    const saveKey = await saveCache(ccacheVariant, primaryKey);
    await saveSummary(ccacheVariant, saveKey, evictedCount);

  } catch (error) {
    // A failure to save cache shouldn't prevent the entire CI run from
    // failing, so do not call setFailed() here.
    core.warning(`Saving cache failed: ${error}`);
  }

  // Since we are not using http requests after this
  // we can safely exit early
  if (earlyExit) {
    process.exit(0);
  }
}

run(true);
export default run;


