// Listing updates are independent of package acceptance and safe to repeat.
import { readFile } from "node:fs/promises";
import { updateFirefoxListing } from "./store-release.mjs";

const config = await readFile(new URL("../release/config.toml", import.meta.url), "utf8");
const description = JSON.parse(
  await readFile(new URL("../release/firefox-description.json", import.meta.url), "utf8"),
);
try {
  await updateFirefoxListing(description, {
    env: {
      ...process.env,
      AMO_GUID: /\[extension.firefox\][\s\S]*?\nid = "([^"]+)"/.exec(config)?.[1],
    },
  });
  console.log("Firefox listing descriptions updated");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
