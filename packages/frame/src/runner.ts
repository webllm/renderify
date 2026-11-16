// Full runner: renders RuntimePlans and JSX/TSX source.
// A namespace import keeps `transform` reachable however the bundler
// interprets this CommonJS module's `__esModule` flag.
import * as Babel from "@babel/standalone";
import type { BabelLike } from "./loop-guard";
import { startRenderifyFrameRunner } from "./runner-core";

startRenderifyFrameRunner({ babel: Babel as unknown as BabelLike });
