// Decoder for NDGR view/v4 and segment streams using the shared nicolive proto.
// This merges the previous view and segment decoders so the main process can
// decode everything from a single module while supporting field #2 chunked
// entries used by live servers.

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

  bool() {
    return this.uint32() !== 0;
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

const asNumber = (value) => {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    if (value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
    return value;
  }
  return value == null ? null : Number(value);
};

// view/v4 messages -----------------------------------------------------------
const decodeViewSegment = (reader, length) => {
  const end = length === undefined ? reader.len : reader.pos + length;
  const message = {};
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.uri = reader.string();
        break;
      case 2:
        message.from = asNumber(reader.int64());
        break;
      case 3:
        message.until = asNumber(reader.int64());
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
};

const decodeNext = (reader, length) => {
  const end = length === undefined ? reader.len : reader.pos + length;
  const message = {};
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.at = asNumber(reader.int64());
        break;
      case 2:
        message.cursor = reader.string();
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
};

const decodePrevious = (reader, length) => {
  const end = length === undefined ? reader.len : reader.pos + length;
  const message = {};
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.at = asNumber(reader.int64());
        break;
      case 2:
        message.cursor = reader.string();
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
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
      case 3:
        message.cursor = reader.string();
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
};

const decodeEntry = (reader, length) => {
  const end = length === undefined ? reader.len : reader.pos + length;
  const message = {};
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.segment = decodeViewSegment(reader, reader.uint32());
        break;
      case 2:
        message.next = decodeNext(reader, reader.uint32());
        break;
      case 3:
        message.previous = decodePrevious(reader, reader.uint32());
        break;
      case 4:
        message.reconnect = decodeReconnect(reader, reader.uint32());
        break;
      case 5:
        message.ping = {};
        break;
      case 6:
        message.history = {};
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
};

const decodeChunkedEntry = (buf) => {
  const reader = buf instanceof Reader ? buf : new Reader(buf);
  const message = { entries: [] };
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.entries.push(decodeEntry(reader, reader.uint32()));
        break;
      default:
        // Field #2 is used for backward/snapshot data on some servers and is
        // not part of the entries array. Skip safely so the decoder does not
        // attempt to parse it as an entry and hit EOF mid-string.
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
};

const decodeViewPayload = (buf) => {
  const reader = buf instanceof Reader ? buf : new Reader(buf);
  if (reader.len === 0) return { entries: [] };

  const firstTag = reader.uint32();
  reader.pos = 0;

  const field = firstTag >>> 3;
  const wireType = firstTag & 7;

  if ((field === 1 || field === 2) && wireType === 2) {
    return decodeChunkedEntry(reader);
  }

  return { entries: [decodeEntry(reader)] };
};

// segment messages -----------------------------------------------------------
const decodeSegmentReconnect = (reader, length) => {
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
      case 3:
        message.cursor = reader.string();
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
        message.anonymous = reader.bool();
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
};

const decodeStatistics = (reader, length) => {
  const end = length === undefined ? reader.len : reader.pos + length;
  const message = {};
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.watchCount = asNumber(reader.uint64());
        break;
      case 2:
        message.commentCount = asNumber(reader.uint64());
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
};

const decodeMessage = (reader, length) => {
  const end = length === undefined ? reader.len : reader.pos + length;
  const message = {};
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.chat = decodeChat(reader, reader.uint32());
        break;
      case 2:
        message.reconnect = decodeSegmentReconnect(reader, reader.uint32());
        break;
      case 3:
        message.statistics = decodeStatistics(reader, reader.uint32());
        break;
      case 4:
        message.ping = {};
        break;
      case 5:
        message.end = {};
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
};

const decodeChunkedMessage = (buf) => {
  const reader = buf instanceof Reader ? buf : new Reader(buf);
  const message = { messages: [] };
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.messages.push(decodeMessage(reader, reader.uint32()));
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return message;
};

module.exports = {
  Reader,
  decodeChunkedEntry,
  decodeEntry,
  decodeViewPayload,
  decodeChunkedMessage,
};
