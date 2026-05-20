#!/usr/bin/env node
// One-command VAPID key generator for Web Push.
//
// Run from anywhere in the repo:
//   npm run vapid --prefix backend
// Or from inside backend/:
//   npm run vapid
//
// What it does:
//   1. Generates a P-256 keypair (the format Web Push expects).
//   2. Encodes the public key in uncompressed form, base64url (65 bytes).
//   3. Encodes the private key d-value, base64url (32 bytes).
//   4. Prints the exact `wrangler secret put` commands you need to run,
//      with the values pre-filled so you can copy-paste-run.
//
// VAPID keys identify the push sender to the browser push service. They
// are not the encryption keys for the push payload — those are derived
// per-subscription. The same VAPID keypair is used for every push the
// Worker sends; rotate only if compromised.
//
// After running this and setting the three secrets, run `npm run ship`
// to redeploy the Worker with push enabled.

import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});

// Export as JWK so we can pull the raw x/y/d coordinates.
const pubJwk = publicKey.export({ format: "jwk" });
const prvJwk = privateKey.export({ format: "jwk" });

// Uncompressed P-256 public key: 0x04 prefix + x (32B) + y (32B) = 65 bytes.
const x = Buffer.from(pubJwk.x, "base64url");
const y = Buffer.from(pubJwk.y, "base64url");
const pub65 = Buffer.concat([Buffer.from([0x04]), x, y]);
const VAPID_PUBLIC_KEY = pub65.toString("base64url");

// Private key d-value: 32 bytes, base64url. Already in that form from JWK.
const VAPID_PRIVATE_KEY = prvJwk.d;

// VAPID subject is a contact URL (mailto: or https:) that push services
// use to identify the sender. Match the support email on /privacy + /terms.
const VAPID_SUBJECT_DEFAULT = "mailto:codydickinson@autopalsusa.com";

console.log("");
console.log("Generated a fresh VAPID keypair for Web Push.");
console.log("");
console.log("──────────────────────────────────────────────────────────────");
console.log("VAPID_PUBLIC_KEY:");
console.log(VAPID_PUBLIC_KEY);
console.log("");
console.log("VAPID_PRIVATE_KEY:");
console.log(VAPID_PRIVATE_KEY);
console.log("");
console.log("VAPID_SUBJECT (suggested — change if your contact email differs):");
console.log(VAPID_SUBJECT_DEFAULT);
console.log("──────────────────────────────────────────────────────────────");
console.log("");
console.log("Next steps — run these three commands from backend/:");
console.log("");
console.log("  echo '" + VAPID_PUBLIC_KEY + "' | npx wrangler secret put VAPID_PUBLIC_KEY");
console.log("  echo '" + VAPID_PRIVATE_KEY + "' | npx wrangler secret put VAPID_PRIVATE_KEY");
console.log("  echo '" + VAPID_SUBJECT_DEFAULT + "' | npx wrangler secret put VAPID_SUBJECT");
console.log("");
console.log("Then deploy: npm run ship");
console.log("");
console.log("Note: save the private key somewhere safe before closing this terminal.");
console.log("If you lose it, every existing push subscription becomes orphaned and");
console.log("users will need to re-subscribe.");
console.log("");
