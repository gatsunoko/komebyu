const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const tmi = require("tmi.js");
const WebSocket = require("ws");
const { decodeEntry, decodeEntryPayload } = require("./proto/messageServer");
const { decodeChunkedMessage } = require("./proto/segmentServer");

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

function normalizeAtSeconds(at) {
  if (at == null) return null;
  if (at === "now") return "now";
  try {
    const raw = BigInt(at);
    const isMillis = raw >= 1_000_000_000_000n;
    const seconds = isMillis ? raw / 1000n : raw;
    const displayMillis = seconds <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(seconds) * 1000
      : null;

    if (displayMillis != null) {
      logNico(
        "normalizeAtSeconds",
        `${at} -> ${seconds.toString()} (${new Date(displayMillis).toISOString()})`
      );
    } else {
      logNico("normalizeAtSeconds", `${at} -> ${seconds.toString()}`);
    }

    return seconds.toString();
  } catch {
    return String(at);
  }
}

function createChunkProcessor(label, onPayload) {
  let buffer = Buffer.alloc(0);

  return (value) => {
    if (value && value.length) buffer = Buffer.concat([buffer, Buffer.from(value)]);

    while (buffer.length) {
      const lengthInfo = readVarint(buffer, 0);
      if (!lengthInfo) break;

      const headerLen = lengthInfo.length;
      const msgLen = Number(lengthInfo.value);

      if (!Number.isFinite(msgLen) || msgLen < 0) {
        logNico(`invalid ${label} frame length`, msgLen);
        buffer = Buffer.alloc(0);
        break;
      }

      const totalLength = headerLen + msgLen;
      if (buffer.length < totalLength) break;

      const payload = buffer.slice(headerLen, totalLength);
      const rawChunk = buffer.slice(0, totalLength);
      buffer = buffer.slice(totalLength);

      onPayload({ payload, rawChunk, payloadLength: msgLen, varintLength: headerLen });
    }
  };
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
  const segmentConnections = new Map();

  const connection = {
    id,
    type: "niconico",
    label: `ニコ生 ${liveId}`,
    status: "ニコ生に接続中…",
    disconnect: null,
  };

  connections.set(id, connection);
  broadcastConnections();

  const watchUrl = `https://live.nicovideo.jp/watch/${liveId}`;
  setStatus(`ニコ生 ${liveId} 接続準備 (step1: 視聴ページ取得開始)`);

  let html;
  try {
    const res = await fetch(watchUrl, {
      headers: { "User-Agent": "komebyu/1.0 (+https://github.com/)" },
    });

    setStatus(`ニコ生 ${liveId} 視聴ページ取得完了 (status: ${res.status}, step1)`);

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
    const embeddedMatch = html.match(/<script[^>]*id="embedded-data"[^>]*data-props="([^"]+)"/i);
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
    const matchUrl = html.match(/wss?:\/[\w./:%#@\-?=~_|!$&'()*+,;]+/i);
    if (matchUrl) watchWsUrl = matchUrl[0];
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
  let watchSocket = null;
  let watchKeepTimer = null;
  let watchReconnectTimer = null;
  let watchReconnectDelay = 1000;
  let messageServerViewUri = null;
  let akashicViewUriIgnored = false;

  const cleanupSegments = async () => {
    const pending = Array.from(segmentConnections.values());
    segmentConnections.clear();
    for (const state of pending) {
      try {
        state.controller.abort();
        await state.promise;
      } catch {}
    }
  };

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
    cleanupSegments();
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

  const ensureCursorOrAtParam = (uri, { cursor, at } = {}) => {
    try {
      const url = new URL(uri);
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      } else if (at) {
        url.searchParams.set("at", at);
      }
      return url.toString();
    } catch {
      const joiner = uri.includes("?") ? "&" : "?";
      if (cursor) return `${uri}${joiner}cursor=${encodeURIComponent(cursor)}`;
      if (at) return `${uri}${joiner}at=${encodeURIComponent(at)}`;
      return uri;
    }
  };

  let lastSegmentCursor = null;

  const startSegmentStream = (uri, options = {}) => {
    if (!uri || connectionAbortController.signal.aborted) return;

    if (options.cursor) {
      lastSegmentCursor = options.cursor;
    }

    const targetUri = ensureCursorOrAtParam(uri, options);
    if (segmentConnections.has(targetUri)) return;

    const controller = new AbortController();
    const state = { controller, promise: null };
    segmentConnections.set(targetUri, state);

    state.promise = (async () => {
      let firstMessageLogged = false;
      let firstPayloadLogged = false;

      try {
        logNico("segmentServer uri", targetUri);
        setStatus(`segment 接続開始 ${targetUri}`);

        const response = await fetch(targetUri, {
          signal: controller.signal,
          headers: {
            "User-Agent": "komebyu/1.0 (+https://github.com/)",
            Accept: "application/octet-stream",
          },
        });

        if (!response.ok || !response.body) {
          setStatus(`segment 接続失敗 ${response.status}`);
          return;
        }

        const reader = response.body.getReader();
        const processChunk = createChunkProcessor("segment", ({
          payload,
          payloadLength,
          varintLength,
        }) => {
          try {
            if (!firstPayloadLogged) {
              logNico("segment payload", {
                hex: payload.slice(0, 16).toString("hex"),
                length: payload.length,
              });
              firstPayloadLogged = true;
            }

            const decoded = decodeChunkedMessage(payload);
            const envelopes = Array.isArray(decoded?.messages)
              ? decoded.messages
              : decoded
                ? [decoded]
                : [];

            for (const msg of envelopes) {
              if (msg?.chat?.content && !firstMessageLogged) {
                logNico("first segment chat", msg.chat.content);
                firstMessageLogged = true;
                setStatus("step5: コメント受信開始 (1件目受信)");
                updateConnectionStatus(id, "接続中 (コメント受信中)");
              }

              if (msg?.chat?.content) {
                messageCount += 1;
                send("message", {
                  connectionId: id,
                  source: connection.label,
                  user: msg.chat.name || msg.chat.userId || "niconico",
                  text: msg.chat.content,
                  badges: {},
                  emotes: null,
                });
              }

              if (msg?.reconnect) {
                if (msg.reconnect.cursor) {
                  lastSegmentCursor = msg.reconnect.cursor;
                }

                if (msg.reconnect.streamUrl) {
                  const normalizedAt = normalizeAtSeconds(msg.reconnect.at);
                  startSegmentStream(msg.reconnect.streamUrl, {
                    cursor: msg.reconnect.cursor || lastSegmentCursor,
                    at: normalizedAt || undefined,
                  });
                }
              }
            }
          } catch (err) {
            logNico("segment decode error", {
              error: err,
              varint: payloadLength,
              varintLength,
              payloadHex: payload.slice(0, 16).toString("hex"),
            });
          }
        });

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          processChunk(value);
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setStatus(`segment エラー: ${e?.message || String(e)}`);
        }
      } finally {
        segmentConnections.delete(targetUri);
      }
    })();
  };

  const connectViewStream = async (initialBase) => {
    let targetBase = initialBase;
    let nextStreamAt = "now";
    let reconnectDelay = 1000;
    let viewErrorBackoff = 500;

    while (!connectionAbortController.signal.aborted && targetBase) {
      if (viewAbort) viewAbort.abort();
      viewAbort = new AbortController();
      const localAbort = viewAbort;
      let updatedDuringStream = false;
      const atValue = normalizeAtSeconds(nextStreamAt) || "now";
      const targetUrl = ensureAtParam(targetBase, atValue);
      let firstChunkLogged = false;
      let firstPayloadLogged = false;

      try {
        updateConnectionStatus(id, "NDGR ビュー取得中…");
        setStatus(`step3: view/v4 接続 ${targetUrl}`);

        const response = await fetch(targetUrl, {
          signal: localAbort.signal,
          headers: {
            "User-Agent": "komebyu/1.0 (+https://github.com/)",
            Accept: "application/octet-stream",
            header: "u=1, i",
            Origin: "https://live.nicovideo.jp",
            Referer: "https://live.nicovideo.jp/",
          },
        });

        if (!response.ok || !response.body) {
          if (response.status === 422) {
            setStatus(
              `view/v4 取得失敗 (${response.status}), ${viewErrorBackoff}ms 後に再試行`
            );
            await new Promise((resolve) => setTimeout(resolve, viewErrorBackoff));
            viewErrorBackoff = Math.min(viewErrorBackoff * 2, 2000);
            nextStreamAt = "now";
            continue;
          }

          setStatus(`view/v4 取得失敗 (${response.status})`);
          break;
        }

        viewErrorBackoff = 500;

        const reader = response.body.getReader();
        const processChunk = createChunkProcessor("view", ({
          payload,
          rawChunk,
          payloadLength,
          varintLength,
        }) => {
          if (!firstChunkLogged) {
            logNico("view chunk0", {
              hex: rawChunk.toString("hex"),
              length: rawChunk.length,
            });
            firstChunkLogged = true;
          }

          try {
            if (!firstPayloadLogged) {
              logNico("view payload", {
                hex: payload.slice(0, 16).toString("hex"),
                length: payload.length,
              });
              firstPayloadLogged = true;
            }

            const decoded = decodeEntryPayload(payload);
            let entries = Array.isArray(decoded?.entries) ? decoded.entries : [];

            if (!entries.length) {
              try {
                const fallback = decodeEntry(payload);
                if (fallback) entries = [fallback];
              } catch (fallbackErr) {
                logNico("view decode fallback failed", fallbackErr);
              }
            }

            for (const entry of entries) {
              if (entry?.segment?.uri) {
                const nextUri = ensureAtParam(entry.segment.uri, "now");
                logNico("segment uri (view)", nextUri);
                startSegmentStream(nextUri);
              }

              if (entry?.reconnect?.at != null) {
                const normalized = normalizeAtSeconds(entry.reconnect.at) || atValue;
                nextStreamAt = normalized;
                updatedDuringStream = true;
                logNico("view reconnect.at", normalized);
                try {
                  localAbort.abort();
                } catch {}
                break;
              }

              if (entry?.next?.at != null) {
                const normalized = normalizeAtSeconds(entry.next.at) || atValue;
                nextStreamAt = normalized;
                updatedDuringStream = true;
                if (entry.next.uri) {
                  targetBase = entry.next.uri;
                  viewUri = entry.next.uri;
                  logNico("view next.uri", targetBase);
                }
                logNico("view next.at", normalized);
                try {
                  localAbort.abort();
                } catch {}
                break;
              }

              if (entry?.reconnect?.streamUrl) {
                const at = normalizeAtSeconds(entry.reconnect.at) || "now";
                if (entry.reconnect.cursor) {
                  lastSegmentCursor = entry.reconnect.cursor;
                }
                startSegmentStream(entry.reconnect.streamUrl, {
                  cursor: entry.reconnect.cursor || lastSegmentCursor,
                  at,
                });
              }
            }
          } catch (e) {
            logNico("view decode error", {
              error: e,
              varint: payloadLength,
              varintLength,
              payloadHex: payload.slice(0, 32).toString("hex"),
              chunkHead: rawChunk.slice(0, 16).toString("hex"),
            });
          }
        });

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          processChunk(value);
        }
      } catch (e) {
        if (!localAbort.signal.aborted) {
          setStatus(`view/v4 取得エラー: ${e?.message || String(e)}`);
        }
      }

      viewAbort = null;
      if (connectionAbortController.signal.aborted) break;

      if (!updatedDuringStream && atValue === nextStreamAt) {
        await new Promise((resolve) => setTimeout(resolve, reconnectDelay));
        reconnectDelay = Math.min(reconnectDelay * 2, 16000);
      } else {
        reconnectDelay = 1000;
      }
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

    if (parsed.type === "messageServer") {
      const candidateUri =
        parsed?.data?.viewUri || parsed?.data?.messageServer?.uri;

      if (candidateUri && candidateUri.includes("mpn.live.nicovideo.jp/api/view")) {
        messageServerViewUri = candidateUri;
        if (viewUri !== candidateUri) {
          viewUri = candidateUri;
          logNico("view uri (messageServer)", viewUri);
          setStatus(`step3: ndgr viewUri = ${viewUri}`);
          connectViewStream(viewUri);
        }
        return;
      }
    }

    if (parsed.type === "akashicMessageServer") {
      const akashicUri = parsed?.data?.viewUri || parsed?.data?.messageServer?.uri;
      if (akashicUri && !akashicViewUriIgnored) {
        logNico("akashic viewUri ignored", akashicUri);
        akashicViewUriIgnored = true;
      }
      return;
    }

    const urlCandidates = Array.from(collectUrlsDeep(parsed));
    const fallbackView = urlCandidates.find((u) =>
      u.includes("mpn.live.nicovideo.jp/api/view/")
    );
    if (!messageServerViewUri && fallbackView && fallbackView !== viewUri) {
      viewUri = fallbackView;
      logNico("view uri (fallback)", viewUri);
      setStatus(`step3: ndgr viewUri = ${viewUri}`);
      connectViewStream(viewUri);
    }
  };

  const openWatchSocket = () => {
    if (watchSocket) {
      try {
        watchSocket.close();
      } catch {}
      watchSocket = null;
    }

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
