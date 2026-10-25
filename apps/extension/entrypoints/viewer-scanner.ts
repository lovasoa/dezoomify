import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { scanViewers } from "../src/job/viewer-scanner.ts";

// A bundled file preserves module imports without page globals or runtime eval.
export default defineUnlistedScript(() => scanViewers(Date.now() + 1000));
