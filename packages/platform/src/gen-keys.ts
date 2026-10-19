import { generateKeyPairSync, randomBytes } from "node:crypto";
import { generateInternalKeys } from "./internal-auth.ts";

// Prints new secrets as .env lines: the internal JWT key pair (PEM, newlines as \n), the master key that tenant keys
// are derived from, and control's sign-in keys (ID token signing key, cookie and TOTP secret). Configs turn \n back
// into newlines.
const { privateKey, publicKey } = await generateInternalKeys();
const oneLine = (pem: string) => pem.trim().replace(/\n/g, "\\n");
const signing = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
console.log(`INTERNAL_JWT_PRIVATE_KEY=${oneLine(privateKey)}`);
console.log(`INTERNAL_JWT_PUBLIC_KEY=${oneLine(publicKey)}`);
console.log(`SECRETS_MASTER_KEY=${randomBytes(32).toString("base64")}`);
console.log(`AUTH_SIGNING_KEY=${oneLine(signing)}`);
console.log(`AUTH_SECRET=${randomBytes(32).toString("base64")}`);
