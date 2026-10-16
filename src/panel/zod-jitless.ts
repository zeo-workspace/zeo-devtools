// Turns zod's JIT off for the panel page, and must be the first module the page evaluates.
//
// The page's CSP has no 'unsafe-eval' (panel-server.ts), and zod v4 compiles object validators
// from generated source with the Function constructor — even its feature probe is reported as a
// CSP violation. zod reads the flag when a schema is *constructed*, not when it parses, and
// `contract-v2.ts` constructs its schemas at import time; so the call cannot sit in main.ts's
// body, which runs after every import. main.ts imports this module first, and wire.ts imports it
// too, so no import order can bypass it.
import { z } from "zod";

z.config({ jitless: true });
