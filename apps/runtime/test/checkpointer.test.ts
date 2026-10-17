import { validate } from "@langchain/langgraph-checkpoint-validation";
import { LibSQLSaver } from "@osiris/core/checkpointer/libsql-saver.ts";
import { createTestDb } from "./helpers.ts";

validate({
  checkpointerName: "LibSQLSaver",
  createCheckpointer: async () => new LibSQLSaver(await createTestDb()),
});
