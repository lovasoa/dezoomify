import { presentProgress } from "../../packages/shared-ui/src/presentation.ts";
import { renderView } from "../../packages/shared-ui/src/view.tsx";
import "../../packages/shared-ui/src/styles/theme.css";

Object.assign(window, { sourceTest: { renderView, presentProgress } });
