#!/usr/bin/env node
/*
 * Utility script to decode NDGR hex payloads using the local hand-written
 * decoder. Pass a hex string and an optional mode (view|segment). Examples:
 *   node proto/decode_hex.js "1298020a..." view
 *   node proto/decode_hex.js "0a0608..." segment
 */
const { decodeViewPayload, decodeChunkedMessage } = require("./nicolive");

const hex = (process.argv[2] || "").replace(/\s+/g, "");
const mode = (process.argv[3] || "view").toLowerCase();

if (!hex) {
  console.error("Usage: node proto/decode_hex.js <hex> [view|segment]");
  process.exit(1);
}

const buffer = Buffer.from(hex, "hex");
let result;

if (mode === "segment") {
  result = decodeChunkedMessage(buffer);
} else {
  result = decodeViewPayload(buffer);
}

console.dir(result, { depth: 10 });
