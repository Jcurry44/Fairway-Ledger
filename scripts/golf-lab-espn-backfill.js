#!/usr/bin/env node
/*
 * Run a saved-file ESPN historical scoreboard backfill from a manifest.
 *
 * This script does not fetch remote data. Save raw ESPN scoreboard JSON files
 * first, list them in a manifest, then this runner adapts them sequentially so
 * multi-event historical folders stay deterministic.
 */
const fsp = require("node:fs/promises");
const path = require("node:path");
const Warehouse = require("../lib/golf-lab-warehouse.js");
const { adaptEspnScoreboard } = require("./golf-lab-espn.js");
const {
  buildGolfLabBundleFromDirectory,
  buildGolfLabBuildReport
} = require("./golf-lab-build.js");

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseArgs(argv) {
  const args = {
    provider: "ESPN public historical scoreboard",
    pretty: true,
    clean: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--manifest") args.manifestFile = argv[index += 1];
    else if (token === "--out") args.outputDir = argv[index += 1];
    else if (token === "--build-out") args.bundleFile = argv[index += 1];
    else if (token === "--report") args.reportFile = argv[index += 1];
    else if (token === "--provider") args.provider = argv[index += 1];
    else if (token === "--clean") args.clean = true;
    else if (token === "--compact") args.pretty = false;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-espn-backfill.js --manifest <file.json> --out <folder> [options]",
    "",
    "Options:",
    "  --build-out <file>          Optional Golf Lab import bundle output.",
    "  --report <file>             Optional build report output.",
    "  --provider <name>           Bundle/report provider label.",
    "  --clean                     Clear existing collection CSVs in --out before adapting.",
    "  --compact                   Write bundle/report JSON without indentation."
  ].join("\n");
}

function manifestEntries(manifest) {
  if (Array.isArray(manifest)) return manifest;
  if (Array.isArray(manifest.events)) return manifest.events;
  if (Array.isArray(manifest.backfill)) return manifest.backfill;
  throw new Error("Backfill manifest must be an array or contain an events array.");
}

function resolveFrom(baseDir, filePath) {
  const clean = cleanString(filePath);
  if (!clean) return "";
  return path.isAbsolute(clean) ? clean : path.resolve(baseDir, clean);
}

async function cleanOutputCollections(outputDir) {
  await fsp.mkdir(outputDir, { recursive: true });
  const fileNames = Object.keys(Warehouse.COLLECTION_COLUMNS).map((collection) =>
    `${collection.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}.csv`
  );
  await Promise.all(fileNames.map(async (fileName) => {
    try {
      await fsp.unlink(path.join(outputDir, fileName));
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }));
}

async function runEspnBackfill(manifestFile, outputDir, options = {}) {
  const resolvedManifest = path.resolve(manifestFile);
  const resolvedOutput = path.resolve(outputDir);
  const manifestDir = path.dirname(resolvedManifest);
  const manifest = JSON.parse(await fsp.readFile(resolvedManifest, "utf8"));
  const events = manifestEntries(manifest);
  if (!events.length) throw new Error("Backfill manifest does not include any events.");
  if (options.clean) await cleanOutputCollections(resolvedOutput);

  const adapted = [];
  for (const entry of events) {
    const inputFile = resolveFrom(manifestDir, entry.inputFile || entry.rawFile || entry.file);
    if (!inputFile) throw new Error("Every backfill event must include inputFile.");
    const result = await adaptEspnScoreboard(inputFile, resolvedOutput, {
      ...entry,
      inputFile: undefined,
      rawFile: undefined,
      file: undefined
    });
    adapted.push({
      inputFile,
      eventId: result.summary.eventId,
      eventName: result.summary.eventName,
      players: result.summary.players,
      completedRounds: result.summary.completedRounds,
      skippedPartialRounds: result.summary.skippedPartialRounds
    });
  }

  let bundle = null;
  if (options.bundleFile || options.reportFile) {
    bundle = await buildGolfLabBundleFromDirectory(resolvedOutput, { provider: options.provider });
    if (options.bundleFile) {
      await fsp.mkdir(path.dirname(path.resolve(options.bundleFile)), { recursive: true });
      await fsp.writeFile(
        options.bundleFile,
        JSON.stringify(bundle, null, options.pretty === false ? 0 : 2),
        "utf8"
      );
    }
    if (options.reportFile) {
      await fsp.mkdir(path.dirname(path.resolve(options.reportFile)), { recursive: true });
      await fsp.writeFile(
        options.reportFile,
        JSON.stringify(buildGolfLabBuildReport(bundle), null, options.pretty === false ? 0 : 2),
        "utf8"
      );
    }
  }

  return {
    manifestFile: resolvedManifest,
    outputDir: resolvedOutput,
    adapted,
    bundleReport: bundle ? bundle.report : null
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.manifestFile || !args.outputDir) throw new Error(`${usage()}\n\nMissing --manifest or --out.`);
  const result = await runEspnBackfill(args.manifestFile, args.outputDir, args);
  console.log(`Golf Lab ESPN backfill adapted: ${result.outputDir}`);
  result.adapted.forEach((event) => {
    console.log(`${event.eventId}: ${event.players} players | ${event.completedRounds} completed rounds | ${event.skippedPartialRounds} partial rounds skipped`);
  });
  if (result.bundleReport) {
    console.log(`${result.bundleReport.totalRecords} records | warehouse score ${result.bundleReport.score} | grade ${result.bundleReport.grade}`);
  }
  return 0;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  manifestEntries,
  runEspnBackfill,
  usage
};
