import { installPageAgent } from "@dezoomify/page-agent";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

// A bundled file preserves module imports without page globals or runtime eval.
export default defineUnlistedScript(installPageAgent);
