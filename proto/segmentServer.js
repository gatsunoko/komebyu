// Decoder for NDGR data/segment/v4 frames (comment stream).

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
        message.cursor = String(asNumber(reader.int64()));
        break;
      case 2:
        message.streamUrl = reader.string();
        break;
      case 3:
        message.at = asNumber(reader.int64());
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
};

const decodeChat = (reader, length) => {
  const end = length === undefined ? reader.len : reader.pos + length;
  const message = {};
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.roomName = reader.string();
        break;
      case 2:
        message.threadId = reader.string();
        break;
      case 3:
        message.no = asNumber(reader.int64());
        break;
      case 4:
        message.vpos = asNumber(reader.int64());
        break;
      case 5:
        message.content = reader.string();
        break;
      case 6:
        message.userId = reader.string();
        break;
      case 7:
        message.name = reader.string();
        break;
      case 8:
        message.mail = reader.string();
        break;
      case 9:
        message.anonymous = reader.uint32() !== 0;
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

const decodeSegmentPayload = (buf) => {
  const reader = buf instanceof Reader ? buf : new Reader(buf);
  const message = {};
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.serverTime = { currentMs: asNumber(reader.int64()) };
        break;
      case 2:
        message.reconnect = decodeReconnect(reader, reader.uint32());
        break;
      case 3:
        message.cursor = String(asNumber(reader.int64()));
        break;
      case 4:
        message.ping = {};
        break;
      case 7:
        message.chat = decodeChat(reader, reader.uint32());
        break;
      case 8:
        message.statistics = {};
        reader.skipType(tag & 7);
        break;
      case 9:
        message.error = decodeError(reader, reader.uint32());
        break;
      case 10:
        message.disconnect = { reason: reader.string() };
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
};

module.exports = { decodeSegmentPayload, Reader };
