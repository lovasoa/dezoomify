import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { scanViewers } from "@dezoomify/page-agent";

// A bundled file preserves module imports without page globals or runtime eval.
export default defineUnlistedScript(scanViewers);
