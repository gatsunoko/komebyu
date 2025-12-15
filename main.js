const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const tmi = require("tmi.js");
const WebSocket = require("ws");
const {
  decodeMessageServerPayload,
  extractSegmentUrisFromView,
} = require("./proto/messageServer");
const { decodeSegmentPayload } = require("./proto/segmentServer");

const NICO_DEBUG = process.env.NICO_DEBUG !== "false";

process.on("uncaughtException", (err) => {
  console.log("[uncaughtException]", err);
});

process.on("unhandledRejection", (reason) => {
  console.log("[unhandledRejection]", reason);
});

function logNico(...args) {
  if (!NICO_DEBUG) return;
  console.log("[nico]", ...args);
}

function decodeHtmlEntities(text) {
  if (!text) return "";
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }

    if (entity.startsWith("#")) {
      const code = parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }

    if (named[entity]) return named[entity];
    return `&${entity};`;
  });
}

function collectUrlsDeep(value, results = new Set(), seen = new Set()) {
  if (value == null) return results;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^(https?:|wss?:|ws:)/i.test(trimmed)) {
      results.add(trimmed);
    }
    return results;
  }

  if (typeof value !== "object") return results;
  if (seen.has(value)) return results;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectUrlsDeep(item, results, seen);
    return results;
  }

  for (const key of Object.keys(value)) {
    collectUrlsDeep(value[key], results, seen);
  }

  return results;
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

function readLengthDelimited(buf, offset) {
  const lenInfo = readVarint(buf, offset);
  if (!lenInfo) return null;
  const len = Number(lenInfo.value);
  const start = offset + lenInfo.length;
  const end = start + len;
  if (end > buf.length) return null;
  return { value: buf.slice(start, end), bytesRead: lenInfo.length + len };
}

function decodeString(buf, offset) {
  const data = readLengthDelimited(buf, offset);
  if (!data) return null;
  return { value: Buffer.from(data.value).toString("utf8"), bytesRead: data.bytesRead };
}

function decodeChatMessage(buf) {
  let pos = 0;
  const chat = {};
  while (pos < buf.length) {
    const tagInfo = readVarint(buf, pos);
    if (!tagInfo) break;
    pos += tagInfo.length;
    const field = tagInfo.value >> 3;
    const wire = tagInfo.value & 0x7;
    if (wire === 2) {
      const strVal = decodeString(buf, pos);
      if (!strVal) break;
      pos += strVal.bytesRead;
      if (field === 1) chat.roomName = strVal.value;
      else if (field === 2) chat.threadId = strVal.value;
      else if (field === 5) chat.content = strVal.value;
      else if (field === 6) chat.userId = strVal.value;
      else if (field === 7) chat.name = strVal.value;
      else if (field === 8) chat.mail = strVal.value;
      continue;
    }
    if (wire === 0) {
      const intVal = readVarint(buf, pos);
      if (!intVal) break;
      pos += intVal.length;
      if (field === 3) chat.no = intVal.value;
      else if (field === 4) chat.vpos = intVal.value;
      else if (field === 9) chat.anonymous = Boolean(intVal.value);
      continue;
    }
    break;
  }
  return chat;
}

function decodeReconnect(buf) {
  let pos = 0;
  const data = {};
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos += tag.length;
    const field = tag.value >> 3;
    const wire = tag.value & 0x7;
    if (wire === 0) {
      const intVal = readVarint(buf, pos);
      if (!intVal) break;
      pos += intVal.length;
      if (field === 1) data.at = intVal.value;
      continue;
    }
    if (wire === 2) {
      const strVal = decodeString(buf, pos);
      if (!strVal) break;
      pos += strVal.bytesRead;
      if (field === 2) data.streamUrl = strVal.value;
      continue;
    }
    break;
  }
  return data;
}

function decodeError(buf) {
  let pos = 0;
  const data = {};
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos += tag.length;
    const field = tag.value >> 3;
    const wire = tag.value & 0x7;
    if (wire === 2) {
      const strVal = decodeString(buf, pos);
      if (!strVal) break;
      pos += strVal.bytesRead;
      if (field === 1) data.code = strVal.value;
      else if (field === 2) data.message = strVal.value;
      continue;
    }
    break;
  }
  return data;
}

function decodeRoom(buf) {
  let pos = 0;
  const data = {};
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos += tag.length;
    const field = tag.value >> 3;
    const wire = tag.value & 0x7;
    if (wire === 2) {
      if (field === 4) {
        const nested = readLengthDelimited(buf, pos);
        if (!nested) break;
        pos += nested.bytesRead;
        const decoded = decodeRoom(nested.value);
        data.messageServer = decoded;
        continue;
      }
      const strVal = decodeString(buf, pos);
      if (!strVal) break;
      pos += strVal.bytesRead;
      if (field === 1) data.name = strVal.value;
      else if (field === 2) data.messageServerUrl = strVal.value;
      else if (field === 3) data.threadId = strVal.value;
      else if (field === 1) data.url = strVal.value;
      continue;
    }
    break;
  }
  return data;
}

let win = null;
const connections = new Map();

function send(type, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send("twitch:event", { type, payload });
  }
}

function setStatus(text) {
  send("status", { global: text });
  console.log("[status]", text);
}

function broadcastConnections() {
  send(
    "connections",
    Array.from(connections.values()).map(({ id, label, type, status }) => ({
      id,
      label,
      type,
      status,
    }))
  );
}

async function disconnectConnection(id) {
  const conn = connections.get(id);
  if (!conn) return;

  if (typeof conn.disconnect === "function") {
    try {
      await conn.disconnect();
    } catch {}
  }

  connections.delete(id);
  broadcastConnections();
}

async function disconnectAll() {
  const ids = Array.from(connections.keys());
  for (const id of ids) {
    await disconnectConnection(id);
  }
}

function parseTwitchChannel(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    if (url.hostname.endsWith("twitch.tv")) {
      const maybeChannel = url.pathname.split("/").find((part) => part);
      if (maybeChannel) return maybeChannel.toLowerCase();
    }
  } catch {}

  const withoutPrefix = trimmed.replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "");
  const normalized = withoutPrefix.replace(/^#/, "").split("/")[0];

  return normalized.toLowerCase();
}

function updateConnectionStatus(id, status) {
  const conn = connections.get(id);
  if (!conn) return;
  conn.status = status;
  broadcastConnections();
}

function parseNiconicoId(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;

  const lvMatch = trimmed.match(/lv\d+/i);
  if (lvMatch) return lvMatch[0].toLowerCase();

  try {
    const url = new URL(trimmed);
    const possibleId = url.pathname.split("/").find((p) => /^lv\d+$/i.test(p));
    return possibleId ? possibleId.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function connectNiconico(liveUrlOrId) {
  const liveId = parseNiconicoId(liveUrlOrId);
  if (!liveId) {
    setStatus("ニコ生のURLまたはID (lv～) を入力してね");
    return;
  }

  const id = `niconico:${liveId}`;
  if (connections.has(id)) {
    setStatus(`${liveId} は既に接続中です`);
    return;
  }

  let viewAbort = null;

  const connection = {
    id,
    type: "niconico",
    label: `ニコ生 ${liveId}`,
    status: "ニコ生に接続中…",
    disconnect: async () => {
      if (viewAbort) viewAbort.abort();
    },
  };

  connections.set(id, connection);
  broadcastConnections();

  const watchUrl = `https://live.nicovideo.jp/watch/${liveId}`;
  setStatus(`ニコ生 ${liveId} 接続準備 (step1: 視聴ページ取得開始)`);

  let html;
  try {
    const res = await fetch(watchUrl, {
      headers: {
        "User-Agent": "komebyu/1.0 (+https://github.com/)",
      },
    });

    setStatus(
      `ニコ生 ${liveId} 視聴ページ取得完了 (status: ${res.status}, step1)`
    );

    if (!res.ok) {
      await disconnectConnection(id);
      return;
    }

    html = await res.text();
    logNico("watch html length", html.length);
  } catch (e) {
    setStatus(`ニコ生取得失敗: ${e?.message || String(e)}`);
    await disconnectConnection(id);
    return;
  }

    logNico("step2: watch websocket url search");

      const findProps = () => {
      const embeddedMatch = html.match(
        /<script[^>]*id="embedded-data"[^>]*data-props="([^"]+)"/i
      );
      if (embeddedMatch) return embeddedMatch[1];
      const genericMatch = html.match(/data-props="([^"]+)"/i);
      if (genericMatch) return genericMatch[1];
      return null;
    };

    let watchWsUrl = null;

    const rawProps = findProps();
    if (rawProps) {
      try {
        const decodedJson = decodeHtmlEntities(rawProps);
        const props = JSON.parse(decodedJson);
        logNico("data-props parse success");
        watchWsUrl =
          props?.site?.relive?.watchServer?.url ||
          props?.site?.program?.watchServer?.url ||
          props?.program?.broadcaster?.socialGroup?.watchServer?.url ||
          props?.program?.broadcast?.watchServer?.url ||
          props?.watchServer?.url;
      } catch (e) {
        logNico("data-props parse failed", e);
      }
    }

    if (!watchWsUrl) {
      const matchUrl = html.match(/wss?:\/\/[\w./:%#@\-?=~_|!$&'()*+,;]+/i);
      if (matchUrl) {
        watchWsUrl = matchUrl[0];
      }
    }

    if (watchWsUrl) {
      const cleaned = decodeHtmlEntities(String(watchWsUrl)).trim();
      const match = cleaned.match(/wss?:\/\/[^"'<>\s]+/);
      watchWsUrl = match ? match[0] : null;
    }

    if (!watchWsUrl) {
      setStatus("NDGRのwatch WS URLが取得できませんでした (step2)");
      await disconnectConnection(id);
      return;
    }

    setStatus(`step2a: watch WS url = ${watchWsUrl}`);

    const connectionAbortController = new AbortController();
    let messageCount = 0;
    let viewUri = null;
    let segmentUrl = null;
    let segmentAbort = null;
    let segmentPromise = null;
    let segmentRunning = false;
    let segmentReconnectDelay = 1000;
    let segmentCursor = null;
    let watchSocket = null;
    let watchKeepTimer = null;
    let watchReconnectTimer = null;
    let watchReconnectDelay = 1000;

    connectionAbortController.signal.addEventListener("abort", () => {
      viewAbort?.abort();
      segmentAbort?.abort();
    });

    const cleanup = () => {
      if (watchReconnectTimer) {
        clearTimeout(watchReconnectTimer);
        watchReconnectTimer = null;
      }
      if (watchKeepTimer) {
        clearInterval(watchKeepTimer);
        watchKeepTimer = null;
      }
      if (watchSocket) {
        try {
          watchSocket.close();
        } catch {}
        watchSocket = null;
      }
      connectionAbortController.abort();
      viewAbort?.abort();
      segmentAbort?.abort();
    };

  connection.disconnect = async () => cleanup();

  const ensureAtParam = (uri, atValue) => {
    try {
      const url = new URL(uri);
      url.searchParams.set("at", atValue);
      return url.toString();
    } catch {
      const joiner = uri.includes("?") ? "&" : "?";
      return `${uri}${joiner}at=${encodeURIComponent(atValue)}`;
    }
  };

  const connectSegmentStream = async (uri) => {
    if (!uri || connectionAbortController.signal.aborted) return;

    if (segmentRunning && uri === segmentUrl) {
      return;
    }

    if (segmentRunning) {
      segmentAbort?.abort();
      if (segmentPromise) {
        await segmentPromise.catch(() => {});
      }
    }

    segmentAbort = new AbortController();
    const localAbort = segmentAbort;
    segmentRunning = true;
    segmentUrl = uri;
    segmentReconnectDelay = 1000;

    logNico("segmentServer uri", uri);
    setStatus(`segment 接続開始 ${uri}`);

    const runSegment = async () => {
      let buffer = Buffer.alloc(0);
      let totalBytes = 0;
      let reconnectReason = "done";
      let firstChunkLogged = false;

      try {
        const response = await fetch(uri, {
          signal: localAbort.signal,
          headers: {
            "User-Agent": "komebyu/1.0 (+https://github.com/)",
            Accept: "application/octet-stream",
          },
        });

        if (!response.ok || !response.body) {
          reconnectReason = `bad-status-${response.status}`;
          return { reason: reconnectReason, totalBytes };
        }

        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            reconnectReason = "done";
            break;
          }
          if (value && value.length) {
            const chunk = Buffer.from(value);
            totalBytes += chunk.length;
            buffer = Buffer.concat([buffer, chunk]);
          }

          while (buffer.length) {
            const lengthInfo = readVarint(buffer, 0);
            if (!lengthInfo) break;
            const messageLength = Number(lengthInfo.value);
            const headerOffset = lengthInfo.length;
            const chunkEnd = headerOffset + messageLength;
            if (buffer.length < chunkEnd) break;
            if (messageLength < 1) {
              buffer = buffer.slice(headerOffset);
              continue;
            }

            const payload = buffer.slice(headerOffset, chunkEnd);
            const rawChunk = buffer.slice(0, chunkEnd);
            buffer = buffer.slice(chunkEnd);

            if (!firstChunkLogged) {
              logNico("segment chunk0", {
                hex: rawChunk.toString("hex"),
                length: rawChunk.length,
              });
              firstChunkLogged = true;
            }

            try {
              const decoded = decodeSegmentPayload(payload);
              if (decoded && Object.keys(decoded).length) {
                handleSegmentMessage(decoded);
              }
            } catch (e) {
              logNico("segment decode error", {
                error: e,
                payloadHex: payload.slice(0, 32).toString("hex"),
                payloadLength: payload.length,
              });
            }
          }
        }
      } catch (e) {
        reconnectReason = localAbort.signal.aborted ? "abort" : "stream-error";
      }

      return { reason: reconnectReason, totalBytes };
    };

    segmentPromise = runSegment();

    const result = await segmentPromise;
    const reason = result?.reason || (segmentAbort.signal.aborted ? "abort" : "unknown");
    const totalBytes = result?.totalBytes ?? 0;

    segmentRunning = false;
    segmentAbort = null;

    logNico("segmentServer ended", { reason, totalBytes });
    setStatus(`segmentServer end ${reason} bytes=${totalBytes}`);

    if (!connectionAbortController.signal.aborted && reason !== "abort") {
      const nextUri = segmentUrl || ensureAtParam(uri, segmentCursor || "now");
      setTimeout(() => connectSegmentStream(nextUri), segmentReconnectDelay);
      segmentReconnectDelay = Math.min(segmentReconnectDelay * 2, 30000);
    }
  };

  const handleSegmentMessage = (msg) => {
    if (!msg) return;
    if (msg.ping) return;
    if (msg.serverTime) return;
    if (msg.statistics) return;

    if (msg.cursor) {
      segmentCursor = msg.cursor;
    }

    if (msg.error) {
      setStatus(`ニコ生エラー: ${msg.error.code || msg.error.message || "unknown"}`);
      return;
    }

    if (msg.disconnect) {
      updateConnectionStatus(id, `切断: ${msg.disconnect.reason || "unknown"}`);
      disconnectConnection(id);
      return;
    }

    if (msg.reconnect) {
      if (msg.reconnect.cursor) segmentCursor = msg.reconnect.cursor;
      if (msg.reconnect.at) segmentCursor = msg.reconnect.at;
      if (msg.reconnect.streamUrl) segmentUrl = msg.reconnect.streamUrl;
      return;
    }

    if (msg.chat && msg.chat.content) {
      messageCount += 1;
      if (messageCount === 1) {
        setStatus("step5: コメント受信開始 (1件目受信)");
        updateConnectionStatus(id, "接続中 (コメント受信中)");
      }

      send("message", {
        connectionId: id,
        source: connection.label,
        user: msg.chat.name || msg.chat.userId || "niconico",
        text: msg.chat.content,
        badges: {},
        emotes: null,
      });
      return;
    }
  };

    const connectStream = async (targetUrl) => {
      if (connectionAbortController.signal.aborted) return;

      if (viewAbort) {
        viewAbort.abort();
      }

      viewAbort = new AbortController();
      const localAbort = viewAbort;

      const logDecodeError = (err) => {
        logNico("view decode error", err);
      };

      let discoveredSegmentUri = null;

      const runView = async () => {
        let buffer = Buffer.alloc(0);
        let firstChunkLogged = false;

        try {
          updateConnectionStatus(id, "NDGR ビュー取得中…");
          setStatus(`step3: view/v4 接続 ${targetUrl}`);

          const response = await fetch(targetUrl, {
            signal: localAbort.signal,
            headers: {
              "User-Agent": "komebyu/1.0 (+https://github.com/)",
              Accept: "application/octet-stream",
            },
          });

          if (!response.ok || !response.body) {
            setStatus(`view/v4 取得失敗 (${response.status})`);
            return;
          }

          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            buffer = Buffer.concat([buffer, Buffer.from(value)]);

            while (buffer.length) {
            const lengthInfo = readVarint(buffer, 0);
            if (!lengthInfo) break;
            const messageLength = Number(lengthInfo.value);
            const offset = lengthInfo.length;
            const chunkEnd = offset + messageLength;
            if (buffer.length < chunkEnd) break;
            if (messageLength < 1) {
              buffer = buffer.slice(offset);
              continue;
            }

            const payload = buffer.slice(offset, chunkEnd);
            const rawChunk = buffer.slice(0, chunkEnd);
            buffer = buffer.slice(chunkEnd);

              if (!firstChunkLogged) {
                logNico("view chunk0", {
                  hex: rawChunk.toString("hex"),
                  length: rawChunk.length,
                });
                firstChunkLogged = true;
              }

              try {
                const decoded = decodeMessageServerPayload(payload);
                const segmentUris = extractSegmentUrisFromView(decoded, payload);
                if (segmentUris.length) {
                  const nextUri = ensureAtParam(segmentUris[0], "now");
                  if (!discoveredSegmentUri) {
                    discoveredSegmentUri = nextUri;
                  }
                  logNico("segment uri =", nextUri);
                }
              } catch (e) {
                logDecodeError({
                  error: e,
                  payloadHex: payload.slice(0, 32).toString("hex"),
                  payloadLength: payload.length,
                });
              }
            }
          }
        } catch (e) {
          if (!localAbort.signal.aborted) {
            setStatus(`view/v4 取得エラー: ${e?.message || String(e)}`);
          }
        }
      };

      await runView();

      viewAbort = null;
      logNico("view/v4 handling finished");

      if (connectionAbortController.signal.aborted) return;

      if (discoveredSegmentUri) {
        segmentUrl = discoveredSegmentUri;
        logNico("segment uri =", segmentUrl);
        setStatus("step4: コメント取得開始");
        connectSegmentStream(segmentUrl);
      }
    };

    const handleWatchMessage = (raw) => {
      const text = typeof raw === "string" ? raw : String(raw);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        logNico("watch ws json parse failed", e, text.slice(0, 2000));
        return;
      }

      logNico("watch ws raw", text.slice(0, 2000));
      logNico("watch ws parsed keys", Object.keys(parsed || {}));

      if (parsed.type === "ping") {
        try {
          watchSocket?.send(JSON.stringify({ type: "pong" }));
        } catch {}
        return;
      }

      if (parsed.type === "seat" || parsed.type === "room") {
        try {
          watchSocket?.send(JSON.stringify({ type: "keepSeat" }));
        } catch {}
      }

      const candidateUri =
        parsed?.data?.messageServer?.uri ||
        parsed?.data?.viewUri ||
        parsed?.data?.uri ||
        parsed?.messageServer?.uri ||
        parsed?.room?.messageServer?.uri ||
        parsed?.room?.viewUri;
      const akashicUri =
        parsed?.data?.akashicMessageServer?.viewUri ||
        parsed?.akashicMessageServer?.viewUri ||
        parsed?.room?.akashicMessageServer?.viewUri;

      const urlCandidates = Array.from(collectUrlsDeep(parsed));
      if (urlCandidates.length) {
        logNico("watch ws url candidates", urlCandidates);
      }

      const segmentCandidate = urlCandidates.find((u) =>
        u.includes("mpn.live.nicovideo.jp/data/segment/")
      );
      const viewCandidate =
        urlCandidates.find((u) => u.includes("mpn.live.nicovideo.jp/api/view/")) ||
        candidateUri;

      if (segmentCandidate) {
        const nextUri = ensureAtParam(segmentCandidate, "now");
        logNico("segment uri (watch)", nextUri);
        setStatus("step4: コメント取得開始");
        connectSegmentStream(nextUri);
      }

      const preferredUri = akashicUri || viewCandidate;
      const sourceType = akashicUri
        ? "akashic"
        : viewCandidate
          ? "message"
          : "unknown";

      if (preferredUri) {
        const preview = text.slice(0, 200);
        setStatus(`step2c: watch ws recv ${sourceType}Server ${preview}`);

          if (preferredUri.includes("mpn.live.nicovideo.jp/api/view")) {
            if (viewUri !== preferredUri) {
              viewUri = preferredUri;
              setStatus(`step3: ndgr viewUri (${sourceType}) = ${viewUri}`);
              connectStream(ensureAtParam(viewUri, "now"));
            }
          }
        }
      };

    const openWatchSocket = () => {
      if (watchSocket) {
        try {
          watchSocket.close();
        } catch {}
        watchSocket = null;
      }

      logNico("watch ws url len", String(watchWsUrl).length);
      logNico("watch ws url head", String(watchWsUrl).slice(0, 200));
      logNico("watch ws url tail", String(watchWsUrl).slice(-120));

      watchSocket = new WebSocket(watchWsUrl, {
        headers: { "User-Agent": "komebyu/1.0 (+https://github.com/)" },
      });

      watchSocket.on("open", () => {
        watchReconnectDelay = 1000;
        setStatus("step2b: watch ws open");
        const startWatching = {
          type: "startWatching",
          data: {
            stream: {
              quality: "high",
              protocol: "hls",
              latency: "low",
              chasePlay: false,
            },
            room: { protocol: "webSocket", commentable: true },
            reconnect: false,
          },
        };
        try {
          watchSocket.send(JSON.stringify(startWatching));
        } catch (e) {
          logNico("watch ws startWatching send failed", e);
        }

        if (watchKeepTimer) clearInterval(watchKeepTimer);
        watchKeepTimer = setInterval(() => {
          try {
            if (watchSocket?.readyState === WebSocket.OPEN) {
              watchSocket.ping();
              watchSocket.send(JSON.stringify({ type: "keepSeat" }));
            }
          } catch {}
        }, 30000);
      });

      watchSocket.on("message", (data) => {
        handleWatchMessage(data.toString());
      });

      watchSocket.on("error", (err) => {
        setStatus(`watch ws error: ${err?.message || String(err)}`);
      });

      watchSocket.on("close", (code, reason) => {
        const reasonText = Buffer.isBuffer(reason)
          ? reason.toString("utf8")
          : String(reason || "");
        setStatus(`watch ws close (${code}): ${reasonText}`);
        if (!connectionAbortController.signal.aborted) {
          if (watchReconnectTimer) clearTimeout(watchReconnectTimer);
          watchReconnectTimer = setTimeout(() => {
            openWatchSocket();
          }, watchReconnectDelay);
          watchReconnectDelay = Math.min(watchReconnectDelay * 2, 16000);
        }
      });
    };

    openWatchSocket();
  }

async function connectTwitch(channelRaw) {
  const channel = parseTwitchChannel(channelRaw);
  if (!channel) {
    setStatus("チャンネル名を入力してね");
    return;
  }

  const id = `twitch:${channel}`;
  if (connections.has(id)) {
    setStatus(`#${channel} は既に接続中です`);
    return;
  }

  const connection = {
    id,
    type: "twitch",
    label: `Twitch #${channel}`,
    status: "接続中…",
    disconnect: null,
  };

  connections.set(id, connection);
  broadcastConnections();

  const client = new tmi.Client({
    options: { debug: true },
    connection: { reconnect: true, secure: true },
    channels: [channel],
  });

  connection.disconnect = async () => {
    try {
      await client.disconnect();
    } catch {}
  };

  client.on("connected", (_addr, _port) =>
    updateConnectionStatus(id, `接続中: #${channel}`)
  );
  client.on("reconnect", () => updateConnectionStatus(id, "再接続中…"));
  client.on("reconnect_failed", () =>
    updateConnectionStatus(id, "再接続失敗")
  );
  client.on("disconnected", (reason) => {
    updateConnectionStatus(id, `切断: ${reason || "unknown"}`);
    disconnectConnection(id);
  });

  client.on("notice", (_chan, msgid, message) => {
    setStatus(`[${channel}] NOTICE: ${msgid} ${message}`);
  });

  client.on("message", (_channel, tags, message, self) => {
    if (self) return;
    send("message", {
      connectionId: id,
      source: connection.label,
      user: tags["display-name"] || tags.username || "unknown",
      text: message,
      badges: tags.badges || {},
      emotes: tags.emotes || null,
    });
  });

  client.on("error", (err) => {
    setStatus(`ERROR: ${err?.message || String(err)}`);
  });

  try {
    await client.connect();
  } catch (e) {
    setStatus(`接続失敗: ${e?.message || String(e)}`);
    await disconnectConnection(id);
  }
}

async function connectAuto(input) {
  if (!input) {
    setStatus("チャンネル名またはニコ生URLを入力してね");
    return;
  }

  const maybeNico = parseNiconicoId(input);
  if (maybeNico) {
    await connectNiconico(input);
  } else {
    await connectTwitch(input);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 780,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile("index.html");
}

app.whenReady().then(() => {
  createWindow();
});

app.on("window-all-closed", async () => {
  await disconnectAll();
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("twitch:connect", async (_e, channel) => {
  await connectAuto(channel);
});

ipcMain.handle("twitch:disconnect", async (_e, targetId) => {
  if (targetId) {
    await disconnectConnection(targetId);
  } else {
    await disconnectAll();
  }
});
