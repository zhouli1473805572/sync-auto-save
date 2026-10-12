import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "acorn";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
assert.equal(
  manifest.version,
  pkg.version,
  "Package and manifest versions differ"
);
assert.equal(
  versions[manifest.version],
  manifest.minAppVersion,
  "Minimum versions differ"
);

// Check actual bundled dependencies as well as first-party source linting.
const nodes = [
  parse(readFileSync("main.js", "utf8"), { ecmaVersion: "latest" }),
];
while (nodes.length) {
  const node = nodes.pop();
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression"
  ) {
    const name = node.callee.computed
      ? node.callee.property.value
      : node.callee.property.name;
    const tag = node.arguments[name === "createElementNS" ? 1 : 0];
    assert.ok(
      !(
        (name === "createElement" || name === "createElementNS") &&
        tag?.value?.toLowerCase?.() === "script"
      ),
      "Bundle creates a script element at runtime"
    );
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) nodes.push(...value.filter((item) => item?.type));
    else if (value?.type) nodes.push(value);
  }
}
console.log(
  `Release ${manifest.version}: versions match; bundle contains no script-element creation.`
);
