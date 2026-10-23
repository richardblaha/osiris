import { tmpdir } from "node:os";
import { join } from "node:path";

// Read by mem0ai when it loads, so this module is imported before it: no telemetry, no notices fetched from GitHub,
// and its own files (an install id) in a temp folder instead of the home directory.
process.env.MEM0_TELEMETRY ??= "false";
process.env.MEM0_DIR ??= join(tmpdir(), "mem0");
