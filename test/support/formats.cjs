const { globSync, readFileSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const formats = globSync("fixtures/*/*/input.txt", { cwd: root })
  .sort()
  .map((file) => ({
    name: file.slice(9, -10),
    input: `/fixtures/${file.slice(9, -9)}${readFileSync(path.join(root, file), "utf8").trim()}`,
    viewer: `/${file.slice(0, -9)}viewer.html`,
  }));
module.exports = { formats };
