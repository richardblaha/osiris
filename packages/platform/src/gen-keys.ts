import { randomBytes } from "node:crypto";
import { generateInternalKeys } from "./internal-auth.ts";

// Prints new secrets as .env lines: the internal JWT key pair (PEM, newlines as \n) and the master key that tenant
// keys are derived from. Configs turn \n back into newlines.
const { privateKey, publicKey } = await generateInternalKeys();
const oneLine = (pem: string) => pem.trim().replace(/\n/g, "\\n");
console.log(`INTERNAL_JWT_PRIVATE_KEY=${oneLine(privateKey)}`);
console.log(`INTERNAL_JWT_PUBLIC_KEY=${oneLine(publicKey)}`);
console.log(`SECRETS_MASTER_KEY=${randomBytes(32).toString("base64")}`);
