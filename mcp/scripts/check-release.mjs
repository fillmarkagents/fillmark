// Run before publishing: every dependency is an exact registry version (no file: or ranges), and
// npm-shrinkwrap.json pins the whole tree to those versions.
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const bad = Object.entries(pkg.dependencies ?? {}).filter(([, v]) => !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(v));
if (bad.length) throw new Error(`dependencies must be exact versions: ${bad.map(([k, v]) => `${k}@${v}`).join(", ")}`);
const wrapUrl = new URL("../npm-shrinkwrap.json", import.meta.url);
if (!existsSync(wrapUrl)) throw new Error("npm-shrinkwrap.json is missing");
const wrap = JSON.parse(readFileSync(wrapUrl, "utf8"));
for (const [name, version] of Object.entries(pkg.dependencies)) {
  const got = wrap.packages?.[`node_modules/${name}`]?.version;
  if (got !== version) throw new Error(`shrinkwrap has ${name}@${got}, package.json ${version}`);
  if (!wrap.packages[`node_modules/${name}`].resolved?.startsWith("https://registry.npmjs.org/")) throw new Error(`${name} is not from the npm registry`);
}
console.log("release dependencies OK");
