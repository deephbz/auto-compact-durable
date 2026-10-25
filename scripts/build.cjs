/* Build dist. In a workspace or submodule checkout, npm runs each package's `prepare` in name order, not dependency
 * order, so the rarebit-durable checkout may not have emitted its declarations yet. Build it first when it is a source
 * checkout without them. A registry install ships dist and needs nothing. Run through `npm run`, which puts tsc on PATH. */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

/** The installed dependency: its own node_modules, or the hoisted one of a workspace root. */
function installedDependency() {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", "@hypercarrier", "rarebit-durable");
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return undefined;
  }
}

const dependency = installedDependency();
if (dependency && !fs.existsSync(path.join(dependency, "dist", "index.d.ts")) && fs.existsSync(path.join(dependency, "tsconfig.build.json"))) {
  console.log(`building ${dependency} first: its declarations are not emitted yet`);
  run("npm", ["run", "build"], dependency);
}

fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
run("tsc", ["-p", "tsconfig.build.json"], root);
