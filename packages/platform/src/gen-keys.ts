import { randomBytes } from "node:crypto";
import { generateInternalKeys } from "./internal-auth.ts";

// Prints new secrets for the cluster: the internal JWT key pair and the master key tenant keys are derived from.
const { privateKey, publicKey } = await generateInternalKeys();
console.log(`INTERNAL_JWT_PRIVATE_KEY<<EOF\n${privateKey.trim()}\nEOF`);
console.log(`INTERNAL_JWT_PUBLIC_KEY<<EOF\n${publicKey.trim()}\nEOF`);
console.log(`SECRETS_MASTER_KEY=${randomBytes(32).toString("base64")}`);
