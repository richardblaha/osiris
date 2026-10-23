import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate } from "@langchain/langgraph-checkpoint-validation";
import { FileSaver } from "@osiris/core/checkpointer/file-saver.ts";
import { Records } from "@osiris/core/projects/records.ts";

validate({
  checkpointerName: "FileSaver",
  createCheckpointer: async () => new FileSaver(new Records(mkdtempSync(join(tmpdir(), "osiris-cp-")))),
});
