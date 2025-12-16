const { decodeViewPayload } = require("./proto/nicolive");

function encodeVarint(value) {
  let v = BigInt(value);
  if (v < 0) v = BigInt.asUintN(64, v);
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function makeStringValue(str) {
  const content = Buffer.from(str, "utf8");
  return Buffer.concat([Buffer.from([0x0a]), encodeVarint(content.length), content]);
}

function makeInt64Value(num) {
  const raw = encodeVarint(num);
  return Buffer.concat([Buffer.from([0x0a]), encodeVarint(raw.length), raw]);
}

function buildSampleA() {
  // payload only (reconnectAt inside Int64Value)
  const payloadHex = "220608ffb784ca06";
  return Buffer.from(payloadHex, "hex");
}

function buildSampleB() {
  const nextMessage = Buffer.concat([
    Buffer.from([0x0a]),
    encodeVarint(makeInt64Value(1765874640).length),
    makeInt64Value(1765874640),
    Buffer.from([0x1a]),
    encodeVarint(
      makeStringValue("https://mpn.live.nicovideo.jp/data/backward/v4/sample").length
    ),
    makeStringValue("https://mpn.live.nicovideo.jp/data/backward/v4/sample"),
  ]);

  const snapshotMessage = Buffer.concat([
    encodeVarint(3 << 3 | 2),
    encodeVarint(makeStringValue("https://mpn.live.nicovideo.jp/data/snapshot/v4/sample").length),
    makeStringValue("https://mpn.live.nicovideo.jp/data/snapshot/v4/sample"),
  ]);

  const entry = Buffer.concat([
    Buffer.from([0x12]),
    encodeVarint(nextMessage.length),
    nextMessage,
    snapshotMessage,
  ]);

  const entryField = Buffer.concat([Buffer.from([0x12]), encodeVarint(entry.length), entry]);
  const payload = entryField;

  const frame = Buffer.concat([encodeVarint(payload.length), payload]);
  return { payload, frame };
}

function readVarint(buf, offset = 0) {
  let val = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const b = BigInt(buf[pos]);
    val |= (b & 0x7fn) << shift;
    pos += 1;
    if ((b & 0x80n) === 0n) {
      const num = Number(val);
      return {
        value: Number.isSafeInteger(num) ? num : val,
        length: pos - offset,
      };
    }
    shift += 7n;
  }
  return null;
}

function decodeHex(hex) {
  const cleaned = hex.replace(/\s+/g, "").trim();
  if (!cleaned) return;
  const buf = Buffer.from(cleaned, "hex");
  let payload = buf;
  const info = readVarint(buf, 0);
  if (info && buf.length >= info.length + Number(info.value)) {
    payload = buf.slice(info.length, info.length + Number(info.value));
    console.log(`Detected frame prefix (len=${info.value}, varintLen=${info.length})`);
  }

  try {
    const decoded = decodeViewPayload(payload);
    console.dir(decoded, { depth: null });
  } catch (e) {
    console.error("decode error", e);
  }
}

function run() {
  const input = process.argv[2];
  if (input) {
    console.log("--- decode input ---");
    decodeHex(input);
    return;
  }

  console.log("Usage: node decode_hex.js <hex>\n");
  console.log("Sample A (reconnectAt only)");
  decodeHex(buildSampleA().toString("hex"));
  console.log("\nSample B (chunked entry with backward/snapshot URIs)");
  const sampleB = buildSampleB();
  decodeHex(sampleB.frame.toString("hex"));
}

run();
