/* Verify the package as a consumer sees it: the packed file list, a plain Node import of every export, and a
 * declaration typecheck. `npm run verify:package` builds first. */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = require(path.join(root, "package.json"));

const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }))[0];
const files = packed.files.map((file) => file.path);

// Every export target is a packed file; exports are flat strings so build scanners need no condition resolution.
const targets = [];
for (const [subpath, conditions] of Object.entries(manifest.exports)) {
  for (const [condition, target] of Object.entries(conditions)) {
    if (typeof target !== "string") throw new Error(`export ${subpath} condition ${condition} must be a string`);
    targets.push(target.replace(/^\.\//, ""));
  }
}
for (const target of new Set(targets)) if (!files.includes(target)) throw new Error(`export target missing from package: ${target}`);
for (const file of files) {
  if (!/^(dist\/|LICENSE$|README\.md$|package\.json$)/.test(file)) throw new Error(`unexpected packed file: ${file}`);
  if (/\.test\.|\.tsbuildinfo$/.test(file)) throw new Error(`test or build-cache file packed: ${file}`);
}

// Import every export by package name (self-reference resolves through `exports`, as a consumer's import does).
const probe = path.join(root, ".verify-probe");
fs.rmSync(probe, { recursive: true, force: true });
fs.mkdirSync(probe);
try {
  for (const subpath of Object.keys(manifest.exports)) {
    const specifier = path.posix.join(manifest.name, subpath);
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(specifier)}); console.log(Object.keys(m).sort().join(","));`], { cwd: root, encoding: "utf8" });
    if (!out.trim()) throw new Error(`export ${specifier} has no members`);
    console.log(`import ${specifier}: ${out.trim()}`);
  }
  // Compile a consumer against the emitted declarations. Third-party declarations fail a full library check, so
  // `skipLibCheck` applies; the expect-error lines fail if our types degrade to `any`.
  const probeSource = [
    `import { hcCompactExtension, workingBudget, type CompactRecord } from ${JSON.stringify(manifest.name)};`,
    `import { compactTrigger } from ${JSON.stringify(`${manifest.name}/budget`)};`,
    "const w: number = workingBudget(10);",
    "// @ts-expect-error workingBudget returns a number, not a string",
    "const notString: string = workingBudget(10);",
    "// @ts-expect-error CompactRecord.method is a closed union",
    "const method: CompactRecord['method'] = 'other';",
    "void [w, notString, method, compactTrigger, hcCompactExtension];",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(probe, "probe.ts"), probeSource);
  execFileSync("tsc", ["--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ESNext", path.join(probe, "probe.ts")], { cwd: root, stdio: "inherit" });
} finally {
  fs.rmSync(probe, { recursive: true, force: true });
}
console.log(`package ok: ${files.length} files`);
