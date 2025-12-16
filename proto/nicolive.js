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

  bytes() {
    const length = this.uint32();
    const start = this.pos;
    const end = start + length;
    if (end > this.len) throw new Error("unexpected eof while reading bytes");
    const slice = this.buf.subarray(start, end);
    this.pos = end;
    return Buffer.from(slice);
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
      case 4:
        // Deprecated end group. Nothing to skip explicitly.
        break;
      case 5:
        this.pos += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${wireType}`);
    }
  }
}

const safeToUtf8 = (buf) => {
  try {
    const text = buf.toString("utf8");
    if (Buffer.from(text, "utf8").equals(buf)) return text;
  } catch {}
  return null;
};

const asNumber = (value) => {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    if (value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
    return value;
  }
  return value == null ? null : Number(value);
};

const tryDecodeStringValue = (bytes) => {
  try {
    const reader = new Reader(bytes);
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      const field = tag >>> 3;
      const wireType = tag & 7;
      if (field === 1 && wireType === 2) {
        return reader.string();
      }
      reader.skipType(wireType);
    }
  } catch {}
  return null;
};

const tryDecodeInt64Value = (bytes) => {
  try {
    const reader = new Reader(bytes);
    const end = reader.len;
    while (reader.pos < end) {
      const tag = reader.uint32();
      const field = tag >>> 3;
      const wireType = tag & 7;
      if (field === 1 && (wireType === 0 || wireType === 1 || wireType === 2)) {
        if (wireType === 0) return asNumber(reader.uint64());
        if (wireType === 1) {
          // 64bit fixed
          const start = reader.pos;
          const endPos = start + 8;
          if (endPos > reader.len) throw new Error("unexpected eof while reading fixed64");
          const view = new DataView(reader.buf.buffer, reader.buf.byteOffset + start, 8);
          reader.pos = endPos;
          return Number(view.getBigUint64(0, true));
        }
        if (wireType === 2) {
          const len = reader.uint32();
          const nestedEnd = reader.pos + len;
          if (nestedEnd > reader.len) throw new Error("unexpected eof while reading nested int64");
          const nested = reader.buf.subarray(reader.pos, nestedEnd);
          reader.pos = nestedEnd;
          return tryDecodeInt64Value(Buffer.from(nested));
        }
      } else {
        reader.skipType(wireType);
      }
    }
  } catch {}

  try {
    const raw = new Reader(bytes);
    const val = raw.uint64();
    if (raw.pos === raw.len) return val;
  } catch {}

  return null;
};

const decodeStringFromBytes = (bytes) => {
  const wrapped = tryDecodeStringValue(bytes);
  if (wrapped != null) return wrapped;

  const direct = safeToUtf8(bytes);
  if (direct != null) return direct;

  return null;
};

const readStringFlexible = (reader, wireType) => {
  if (wireType !== 2) {
    reader.skipType(wireType);
    return null;
  }

  const bytes = reader.bytes();
  return decodeStringFromBytes(bytes);
};

const decodeInt64Value = (reader, length) => {
  const end = length === undefined ? reader.len : reader.pos + length;
  let value = null;
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        value = reader.int64();
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }
  return asNumber(value);
};

const readInt64Field = (reader, wireType) => {
  if (wireType === 0) return asNumber(reader.int64());
  if (wireType === 2) {
    const len = reader.uint32();
    const start = reader.pos;
    const end = start + len;
    if (end > reader.len) throw new Error("unexpected eof while reading int64 field");
    const bytes = reader.buf.subarray(start, end);
    reader.pos = end;
    const decoded = tryDecodeInt64Value(Buffer.from(bytes));
    return decoded != null ? decoded : null;
  }
  reader.skipType(wireType);
  return null;
};

const decodeOpaqueCursor = (buf) => {
  try {
    const text = buf.toString("utf8");
    if (Buffer.from(text, "utf8").equals(buf)) {
      return { cursor: text };
    }
  } catch {}

  return { cursor: buf.toString("base64"), cursorBytes: buf };
};

// view/v4 messages -----------------------------------------------------------
const decodeViewSegment = (reader, length) => {
  const end = length === undefined ? reader.len : reader.pos + length;
  const message = {};
  while (reader.pos < end) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    const wireType = tag & 7;
    switch (field) {
      case 1:
        message.from = readInt64Field(reader, wireType);
        break;
      case 2:
        message.until = readInt64Field(reader, wireType);
        break;
      case 3:
        message.uri = readStringFlexible(reader, wireType);
        break;
      case 4:
        message.reconnectAt = readInt64Field(reader, wireType);
        break;
      default:
        reader.skipType(wireType);
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
    const field = tag >>> 3;
    const wireType = tag & 7;
    switch (field) {
      case 1:
        message.at = readInt64Field(reader, wireType);
        break;
      case 2:
        if (wireType === 2) {
          const { cursor, cursorBytes } = decodeOpaqueCursor(reader.bytes());
          message.cursor = cursor;
          if (cursorBytes) message.cursorBytes = cursorBytes;
        } else {
          reader.skipType(wireType);
        }
        break;
      case 3:
        message.uri = readStringFlexible(reader, wireType);
        break;
      default:
        reader.skipType(wireType);
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
    const field = tag >>> 3;
    const wireType = tag & 7;
    switch (field) {
      case 1:
        message.at = readInt64Field(reader, wireType);
        break;
      case 2:
        if (wireType === 2) {
          const { cursor, cursorBytes } = decodeOpaqueCursor(reader.bytes());
          message.cursor = cursor;
          if (cursorBytes) message.cursorBytes = cursorBytes;
        } else {
          reader.skipType(wireType);
        }
        break;
      case 3:
        if (wireType === 2) {
          message.uri = reader.string();
        } else {
          reader.skipType(wireType);
        }
        break;
      default:
        reader.skipType(wireType);
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
    const field = tag >>> 3;
    const wireType = tag & 7;
    switch (field) {
      case 1:
        message.at = readInt64Field(reader, wireType);
        break;
      case 2:
        message.streamUrl = readStringFlexible(reader, wireType);
        break;
      case 3:
        if (wireType === 2) {
          const { cursor, cursorBytes } = decodeOpaqueCursor(reader.bytes());
          message.cursor = cursor;
          if (cursorBytes) message.cursorBytes = cursorBytes;
        } else {
          reader.skipType(wireType);
        }
        break;
      case 4:
        message.reconnectAt = readInt64Field(reader, wireType);
        break;
      default:
        reader.skipType(wireType);
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
    const field = tag >>> 3;
    const wireType = tag & 7;
    switch (field) {
      case 1:
        if (wireType === 2) {
          message.segment = decodeViewSegment(reader, reader.uint32());
        } else {
          reader.skipType(wireType);
        }
        break;
      case 2:
        if (wireType === 2) {
          const bytes = reader.bytes();
          const str = decodeStringFromBytes(bytes);
          if (str && /^https?:\/\//i.test(str)) {
            message.backwardUri = str;
          } else {
            try {
              const decoded = decodeNext(new Reader(bytes));
              message.next = decoded;
              if (decoded?.uri && /^https?:\/\//i.test(decoded.uri)) {
                message.backwardUri = decoded.uri;
              }
            } catch (e) {
              // keep decoding other fields in the same entry
            }
          }
        } else {
          reader.skipType(wireType);
        }
        break;
      case 3:
        if (wireType === 2) {
          const bytes = reader.bytes();
          const str = decodeStringFromBytes(bytes);
          if (str && /^https?:\/\//i.test(str)) {
            message.snapshotUri = str;
          } else {
            try {
              const decoded = decodePrevious(new Reader(bytes));
              message.previous = decoded;
              if (decoded?.uri && /^https?:\/\//i.test(decoded.uri)) {
                message.snapshotUri = decoded.uri;
              }
            } catch (e) {
              // continue decoding other fields
            }
          }
        } else {
          reader.skipType(wireType);
        }
        break;
      case 4:
        if (wireType === 2) {
          try {
            message.reconnect = decodeReconnect(new Reader(reader.bytes()));
          } catch (e) {
            // ignore errors for this frame
          }
        } else {
          reader.skipType(wireType);
        }
        break;
      case 5:
        message.ping = {};
        break;
      case 6:
        message.history = {};
        break;
      default:
        reader.skipType(wireType);
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
      case 2:
        message.entries.push(decodeEntry(reader, reader.uint32()));
        break;
      default:
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
    const field = tag >>> 3;
    const wireType = tag & 7;
    switch (field) {
      case 1:
        message.at = readInt64Field(reader, wireType);
        break;
      case 2:
        message.streamUrl = readStringFlexible(reader, wireType);
        break;
      case 3:
        if (wireType === 2) {
          const { cursor, cursorBytes } = decodeOpaqueCursor(reader.bytes());
          message.cursor = cursor;
          if (cursorBytes) message.cursorBytes = cursorBytes;
        } else {
          reader.skipType(wireType);
        }
        break;
      case 4:
        message.reconnectAt = readInt64Field(reader, wireType);
        break;
      default:
        reader.skipType(wireType);
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
