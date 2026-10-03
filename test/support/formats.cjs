const { existsSync, globSync, readFileSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const formats = globSync("fixtures/*/*/viewer.html", { cwd: root })
  .map((file) => file.split(path.sep).join("/"))
  .sort()
  .map((file) => {
    const dir = path.posix.dirname(file);
    const override = path.join(root, dir, "input.txt");
    return {
      name: dir.slice(9),
      tolerance: path.posix.basename(dir).startsWith("approximate-") ? 2 : 0,
      input: `/${dir}/${existsSync(override) ? readFileSync(override, "utf8").trim() : "viewer.html"}`,
      viewer: `/${file}`,
    };
  });
module.exports = { formats };
