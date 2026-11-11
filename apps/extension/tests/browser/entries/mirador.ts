import { BrowserHost, selectionLimitsFor } from "@dezoomify/browser-runtime";
import { scanViewers } from "@dezoomify/page-agent";
import { collectCandidates, sourceSnapshotLimits } from "../../../src/job/source-snapshot.ts";

Object.assign(window, {
  Inspector: {
    BrowserHost,
    selectionLimitsFor,
    scanViewers,
    collectCandidates,
    sourceSnapshotLimits,
  },
});
