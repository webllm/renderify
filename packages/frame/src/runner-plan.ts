// Declarative-only runner: renders RuntimePlans without bundling Babel, so the
// frame boots much faster for hosts that never render source.
import { startRenderifyFrameRunner } from "./runner-core";

startRenderifyFrameRunner();
