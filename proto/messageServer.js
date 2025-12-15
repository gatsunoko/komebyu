// Decoder for NDGR view/v4 message server frames.
// Only extracts metadata required to locate the segment server URI.

class Reader {
  constructor(buffer) {
    this.buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.pos = 0;
    this.len = this.buf.length;
  }

  uint32() {
    let value = 0;
    let shift = 0;
    while (true) {
      if (this.pos >= this.len) throw new Error("unexpected eof");
      const b = this.buf[this.pos++];
      if (shift < 32) value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return value >>> 0;
      shift += 7;
    }
  }

  int64() {
    return this.uint64();
  }

  uint64() {
    let value = 0n;
    let shift = 0n;
    while (true) {
      if (this.pos >= this.len) throw new Error("unexpected eof");
      const b = BigInt(this.buf[this.pos++]);
      value |= (b & 0x7fn) << shift;
      if ((b & 0x80n) === 0n) break;
      shift += 7n;
    }
    if (value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
    return value;
  }

  string() {
    const length = this.uint32();
    const start = this.pos;
    const end = start + length;
    if (end > this.len) throw new Error("unexpected eof while reading string");
    const slice = this.buf.subarray(start, end);
    this.pos = end;
    return Buffer.from(slice).toString("utf8");
  }

  bytes() {
    const length = this.uint32();
    const start = this.pos;
    const end = start + length;
    if (end > this.len) throw new Error("unexpected eof while reading bytes");
    const slice = this.buf.subarray(start, end);
    this.pos = end;
    return slice;
  }

  skipType(wireType) {
    switch (wireType) {
      case 0:
        while (this.pos < this.len) {
          if ((this.buf[this.pos++] & 0x80) === 0) break;
        }
        break;
      case 1:
        this.pos += 8;
        break;
      case 2: {
        const length = this.uint32();
        this.pos += length;
        break;
      }
      case 5:
        this.pos += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${wireType}`);
    }
  }
}

const asNumber = (val) => {
  if (typeof val === "number") return val;
  if (typeof val === "bigint") {
    if (val <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(val);
    return val;
  }
  return val == null ? null : Number(val);
};

const decodeReconnect = (reader, length) => {
  const end = length === undefined ? reader.len : reader.pos + length;
  const message = {};
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.at = asNumber(reader.int64());
        break;
      case 2:
        message.streamUrl = reader.string();
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
};

const decodeRoom = (reader, length) => {
  const end = length === undefined ? reader.len : reader.pos + length;
  const message = {};
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.name = reader.string();
        break;
      case 2:
        message.messageServerUrl = reader.string();
        break;
      case 3:
        message.threadId = reader.string();
        break;
      case 4:
        message.messageServer = decodeRoom(reader, reader.uint32());
        break;
      case 5:
        message.url = reader.string();
        break;
      case 6:
        message.viewUri = reader.string();
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
};

const decodeError = (reader, length) => {
  const end = length === undefined ? reader.len : reader.pos + length;
  const message = {};
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.code = reader.string();
        break;
      case 2:
        message.message = reader.string();
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
};

const decodeMessageServerPayload = (buf) => {
  const reader = buf instanceof Reader ? buf : new Reader(buf);
  const message = {};
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.serverTime = { currentMs: asNumber(reader.int64()) };
        break;
      case 2:
        message.room = decodeRoom(reader, reader.uint32());
        break;
      case 3:
        message.seat = { id: String(asNumber(reader.int64())) };
        break;
      case 4:
        message.ping = {};
        break;
      case 5:
        message.disconnect = { reason: reader.string() };
        break;
      case 6:
        message.reconnect = decodeReconnect(reader, reader.uint32());
        break;
      case 9:
        message.error = decodeError(reader, reader.uint32());
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
};

const collectSegmentUrisFromText = (text) => {
  const uris = [];
  if (!text) return uris;
  const regex = /https?:\/\/mpn\.live\.nicovideo\.jp\/data\/segment\/v4\/[^\s"']+/g;
  let m;
  while ((m = regex.exec(text))) {
    if (!uris.includes(m[0])) uris.push(m[0]);
  }
  return uris;
};

const extractSegmentUrisFromView = (decoded, rawBuffer) => {
  const uris = [];
  const collectStrings = (value) => {
    if (!value) return;
    if (typeof value === "string") {
      uris.push(...collectSegmentUrisFromText(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collectStrings);
      return;
    }
    if (typeof value === "object") {
      Object.values(value).forEach(collectStrings);
    }
  };

  collectStrings(decoded);

  if (!uris.length && rawBuffer) {
    try {
      uris.push(...collectSegmentUrisFromText(Buffer.from(rawBuffer).toString("utf8")));
    } catch {}
  }

  return Array.from(new Set(uris));
};

module.exports = {
  decodeMessageServerPayload,
  extractSegmentUrisFromView,
  Reader,
};
