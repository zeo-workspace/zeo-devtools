// Builds the panel page (story 055, design.md §A3) into dist/panel/, after `tsc` has built the
// plugin: the browser cannot resolve bare imports, so src/panel/main.ts is bundled by esbuild with
// markdown-it and zod inside. The published package gains no runtime dependency from it.
//
//   dist/panel/index.html                the page (served at `/` by panel-server.ts)
//   dist/panel/assets/main.js (+ .map)   the bundle, an external module script (CSP: no inline)
//   dist/panel/assets/style.css          the page's one stylesheet
//   dist/panel/THIRD_PARTY_LICENSES.txt  the licenses of every bundled package (not served)
//
// Exits non-zero, naming the step and the path, on any failure.
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src", "panel");
const OUT = join(ROOT, "dist", "panel");
const ASSETS = join(OUT, "assets");

async function step(what, path, fn) {
  try {
    return await fn();
  } catch (err) {
    throw new Error(`build-panel: ${what} ${relative(ROOT, path) || path} failed`, { cause: err });
  }
}

/** The package directories (`node_modules/<name>` or `node_modules/@scope/<name>`) of `inputs`. */
function bundledPackages(inputs) {
  const dirs = new Set();
  for (const input of inputs) {
    const parts = input.split(/[\\/]/);
    const at = parts.lastIndexOf("node_modules");
    if (at === -1) {
      continue;
    }
    const name = parts[at + 1]?.startsWith("@")
      ? parts.slice(at + 1, at + 3)
      : parts.slice(at + 1, at + 2);
    dirs.add(join(ROOT, ...parts.slice(0, at + 1), ...name));
  }
  return [...dirs].sort();
}

/** One section per bundled package: its name, version and license file, verbatim. */
async function licenseNotice(dirs) {
  const sections = [];
  for (const dir of dirs) {
    const pkg = JSON.parse(
      await step("reading", join(dir, "package.json"), () =>
        readFile(join(dir, "package.json"), "utf8"),
      ),
    );
    const files = await step("listing", dir, () => readdir(dir));
    const licenseFile = files.find((f) => /^(licen[cs]e|copying)([.-]|$)/i.test(f));
    if (licenseFile === undefined) {
      throw new Error(`build-panel: ${relative(ROOT, dir)} ships no license file`);
    }
    const text = await step("reading", join(dir, licenseFile), () =>
      readFile(join(dir, licenseFile), "utf8"),
    );
    sections.push(`${pkg.name}@${pkg.version} (${pkg.license})\n\n${text.trim()}\n`);
  }
  return `Third-party software bundled into assets/main.js\n\n${sections.join(`\n${"-".repeat(72)}\n\n`)}`;
}

async function main() {
  await step("clearing", OUT, () => rm(OUT, { recursive: true, force: true }));
  await step("creating", ASSETS, () => mkdir(ASSETS, { recursive: true }));

  const result = await step("bundling", join(SRC, "main.ts"), () =>
    build({
      entryPoints: [join(SRC, "main.ts")],
      outfile: join(ASSETS, "main.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: ["chrome120", "firefox128", "safari17"],
      // Minified for the browser to parse; the linked map keeps stacks and devtools readable.
      minify: true,
      sourcemap: "linked",
      // Map positions only: the sources are public already and would triple the package size.
      sourcesContent: false,
      legalComments: "none",
      metafile: true,
      logLevel: "warning",
    }),
  );
  if (result.errors.length > 0) {
    throw new Error(
      `build-panel: bundling src/panel/main.ts reported ${result.errors.length} errors`,
    );
  }

  await step("copying", join(SRC, "index.html"), () =>
    copyFile(join(SRC, "index.html"), join(OUT, "index.html")),
  );
  await step("copying", join(SRC, "style.css"), () =>
    copyFile(join(SRC, "style.css"), join(ASSETS, "style.css")),
  );

  const packages = bundledPackages(Object.keys(result.metafile.inputs));
  const notice = await licenseNotice(packages);
  await step("writing", join(OUT, "THIRD_PARTY_LICENSES.txt"), () =>
    writeFile(join(OUT, "THIRD_PARTY_LICENSES.txt"), notice),
  );

  const names = packages.map((d) => d.split(`node_modules${sep}`).pop()).join(", ");
  console.info(`build-panel: dist/panel built; bundled packages: ${names}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.cause !== undefined) {
    console.error(err.cause);
  }
  process.exit(1);
});
