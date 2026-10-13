import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Embeddings } from "@langchain/core/embeddings";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { Client } from "@libsql/client";
import { createDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import type { Skill } from "../src/agent/skills.ts";
import { fileProvider } from "../src/tenants/provider.ts";
import { TenantRegistry } from "../src/tenants/registry.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "osiris-test-"));

/** Fresh migrated tenant database in a temp file (libSQL `:memory:` loses data across transactions). */
export async function createTestDb(): Promise<Client> {
  const db = createDb(`file:${join(tempDir(), "test.db")}`);
  await migrate(db);
  return db;
}

/** Tenant registry over per-tenant files in a temp dir, with one scripted model shared by all tenants. */
export function createTestTenants(script: AIMessage[] = [], bundledSkills: Skill[] = []) {
  const model = new ScriptedChatModel(script);
  const dir = tempDir();
  const tenants = new TenantRegistry(fileProvider(dir), {
    model,
    embeddings: new WordEmbeddings(),
    embeddingModel: "test:words",
    bundledSkills,
    timezone: "Europe/Prague",
  });
  return { tenants, model, dir };
}

/** Chat model that replies with a scripted sequence of messages and records what it was sent. */
export class ScriptedChatModel extends BaseChatModel {
  calls: BaseMessage[][] = [];

  constructor(private readonly script: AIMessage[]) {
    super({});
  }

  _llmType() {
    return "scripted";
  }

  override bindTools() {
    return this as never;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const message = this.script.shift() ?? new AIMessage("(script exhausted)");
    return { generations: [{ text: message.text, message }] };
  }
}

/** Deterministic bag-of-words embeddings: texts sharing words get similar vectors. */
export class WordEmbeddings extends Embeddings {
  constructor() {
    super({});
  }

  private vector(text: string): number[] {
    const v = new Array<number>(64).fill(0);
    for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
      let h = 0;
      for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % 64]! += 1;
    }
    return v.some((x) => x !== 0) ? v : v.map(() => 1e-6);
  }

  async embedDocuments(texts: string[]) {
    return texts.map((t) => this.vector(t));
  }

  async embedQuery(text: string) {
    return this.vector(text);
  }
}
