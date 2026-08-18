/**
 * Normalises a list of test files to one path per line - relative to `app/`,
 * POSIX-separated, sorted - so that two lists produced on different runners can
 * be compared as text. CI unions the Windows shards' manifests and compares
 * them against the full file list, so a shard that quietly ran half of what it
 * should shows up there as a hole rather than as a green job.
 *
 * Two sources, because they answer different questions:
 *
 *   shard-manifest.mjs <report.json>   what a sharded run actually executed
 *   vitest list --filesOnly | ... -    what the suite contains
 *
 * `vitest list --filesOnly --shard=1/2` would answer the first without running
 * anything, and does not work: `list` accepts `--shard` and ignores it
 * (measured on vitest 4.1.8 - each shard lists the whole suite). The only
 * honest source for "which files did this shard run" is the report of a run
 * that happened.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const [source] = process.argv.slice(2);
if (!source) {
	console.error("usage: shard-manifest.mjs <vitest-json-report>|-");
	process.exit(2);
}

const appRoot = path.resolve(import.meta.dirname, "..");

/*
 * `vitest list` prints paths relative to its root (`app/`) on Linux and macOS
 * and with backslashes on Windows, while the JSON report carries absolute
 * paths. Resolving both against `app/` before relativising makes either spelling
 * land on the same string, which is the only reason a manifest written on a
 * Windows runner can be diffed against one written anywhere else.
 */
const relativeToApp = (file) =>
	path
		.relative(appRoot, path.resolve(appRoot, file.replace(/\\/g, "/")))
		.split(path.sep)
		.join("/");

const readSource = () => {
	if (source === "-") {
		return readFileSync(0, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	}
	const report = JSON.parse(readFileSync(source, "utf8"));
	return (report.testResults ?? []).map((result) => result.name);
};

const files = readSource().map(relativeToApp).sort();

/*
 * An empty list is the failure this guard exists for - a shard whose `--shard`
 * argument never reached vitest, or an enumeration that matched nothing. Fail
 * here rather than write a file whose emptiness reads downstream as "covered".
 */
if (files.length === 0) {
	console.error(`${source === "-" ? "stdin" : source} lists no test files.`);
	process.exit(1);
}

process.stdout.write(`${files.join("\n")}\n`);
