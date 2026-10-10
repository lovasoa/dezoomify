import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { scanOpenSeadragon } from "../src/job/openseadragon-scanner.ts";

// A bundled file preserves module imports without page globals or runtime eval.
export default defineUnlistedScript(() => scanOpenSeadragon(Date.now() + 1000));
