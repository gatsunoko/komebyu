const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const tmi = require("tmi.js");
const WebSocket = require("ws");

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

function readVarint(buf, offset = 0) {
  let val = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos];
    val |= (b & 0x7f) << shift;
    pos += 1;
    if ((b & 0x80) === 0) {
      return { value: val >>> 0, length: pos - offset };
    }
    shift += 7;
  }
  return null;
}

function readLengthDelimited(buf, offset) {
  const lenInfo = readVarint(buf, offset);
  if (!lenInfo) return null;
  const start = offset + lenInfo.length;
  const end = start + lenInfo.value;
  if (end > buf.length) return null;
  return { value: buf.slice(start, end), bytesRead: lenInfo.length + lenInfo.value };
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

function decodeNdgrMessage(buf) {
  let pos = 0;
  const message = {};
  while (pos < buf.length) {
    const tagInfo = readVarint(buf, pos);
    if (!tagInfo) break;
    pos += tagInfo.length;
    const field = tagInfo.value >> 3;
    const wire = tagInfo.value & 0x7;
    if (wire === 2) {
      const ld = readLengthDelimited(buf, pos);
      if (!ld) break;
      pos += ld.bytesRead;
      if (field === 2) message.room = decodeRoom(ld.value);
      else if (field === 5) message.disconnect = { reason: ld.value.toString() };
      else if (field === 6) message.reconnectAt = decodeReconnect(ld.value);
      else if (field === 7) message.chat = decodeChatMessage(ld.value);
      else if (field === 9) message.error = decodeError(ld.value);
      continue;
    }
    if (wire === 0) {
      const intVal = readVarint(buf, pos);
      if (!intVal) break;
      pos += intVal.length;
      if (field === 1) message.serverTime = { currentMs: intVal.value };
      else if (field === 3) message.seat = { id: String(intVal.value) };
      else if (field === 4) message.ping = {};
      continue;
    }
    break;
  }
  return message;
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

  let ndgrAbort = null;

  const connection = {
    id,
    type: "niconico",
    label: `ニコ生 ${liveId}`,
    status: "ニコ生に接続中…",
    disconnect: async () => {
      if (ndgrAbort) ndgrAbort.abort();
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
    const propsMatch = html.match(/data-props="([^"]+)"/);

    let watchWsUrl = null;

    if (propsMatch) {
      try {
        const decodedJson = decodeHtmlEntities(propsMatch[1]);
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
      const matchUrl = html.match(/wss?:\/\/[^"'\s>]+watch[^"'\s<]*/i);
      if (matchUrl) {
        watchWsUrl = matchUrl[0];
      }
    }

    if (!watchWsUrl) {
      setStatus("NDGRのwatch WS URLが取得できませんでした (step2)");
      await disconnectConnection(id);
      return;
    }

    setStatus(`step2a: watch WS url = ${watchWsUrl}`);

    const appendAtParam = (uri) =>
      uri.includes("?") ? `${uri}&at=now` : `${uri}?at=now`;

    const abortController = new AbortController();
    ndgrAbort = abortController;

    let reconnectTimer = null;
    let messageCount = 0;
    let currentStreamUrl = null;
    let viewUri = null;
    let watchSocket = null;
    let watchKeepTimer = null;
    let watchReconnectTimer = null;

    const cleanup = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
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
      abortController.abort();
    };

  connection.disconnect = async () => cleanup();

  const decodeVarint = (buf, offset = 0) => {
    let val = 0;
    let shift = 0;
    let pos = offset;
    while (pos < buf.length) {
      const b = buf[pos];
      val |= (b & 0x7f) << shift;
      pos += 1;
      if ((b & 0x80) === 0) {
        return { value: val, length: pos - offset };
      }
      shift += 7;
    }
    return null;
  };

  const handleMessage = (msg) => {
    if (!msg) return;
    if (msg.ping) return;
    if (msg.serverTime) return;
    if (msg.statistics) return;

    if (msg.error) {
      setStatus(`ニコ生エラー: ${msg.error.code || msg.error.message || "unknown"}`);
      return;
    }

    if (msg.disconnect) {
      updateConnectionStatus(id, `切断: ${msg.disconnect.reason || "unknown"}`);
      disconnectConnection(id);
      return;
    }

    if (msg.reconnectAt) {
      const delay = Number(msg.reconnectAt.at || 0) - Date.now();
      const waitMs = Number.isFinite(delay) && delay > 0 ? delay : 1000;
      logNico("NDGR reconnectAt", msg.reconnectAt, "waitMs", waitMs);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        connectStream(msg.reconnectAt.streamUrl || currentStreamUrl);
      }, waitMs);
      return;
    }

    if (msg.room) {
      const roomInfo = msg.room.messageServer || msg.room;
      const uri =
        roomInfo.messageServerUrl || roomInfo.url || roomInfo.uri || currentStreamUrl;
      logNico("room message", roomInfo);
      setStatus(`step4: NDGRストリーム接続開始 ${uri}`);
      return;
    }

    if (msg.chat && msg.chat.content) {
      messageCount += 1;
      if (messageCount === 1) {
        setStatus("step5: コメント受信開始 (1件目受信)");
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
      updateConnectionStatus(id, "NDGR コメントストリーム接続中…");
      setStatus(`step4: ストリーム接続開始 ${targetUrl}`);
      currentStreamUrl = targetUrl;
    let response;
    try {
      response = await fetch(targetUrl, {
        signal: abortController.signal,
        headers: {
          "User-Agent": "komebyu/1.0 (+https://github.com/)",
          Accept: "application/octet-stream",
        },
      });
    } catch (e) {
      if (abortController.signal.aborted) return;
      setStatus(`NDGR接続失敗: ${e?.message || String(e)}`);
      return;
    }

    logNico("NDGR stream status", response.status);
    if (!response.ok || !response.body) {
      setStatus(`NDGRストリーム取得失敗 (${response.status})`);
      return;
    }

    const reader = response.body.getReader();
    let buffer = Buffer.alloc(0);

    updateConnectionStatus(id, "NDGR コメント受信中");

    while (true) {
      let chunk;
      try {
        const { done, value } = await reader.read();
        if (done) break;
        chunk = Buffer.from(value);
      } catch (e) {
        if (abortController.signal.aborted) break;
        setStatus(`NDGR読込エラー: ${e?.message || String(e)}`);
        break;
      }

      if (chunk && chunk.length) buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length) {
        const lengthInfo = decodeVarint(buffer, 0);
        if (!lengthInfo) break;
        const messageLength = lengthInfo.value;
        const start = lengthInfo.length;
        if (buffer.length < start + messageLength) break;

        const messageBytes = buffer.slice(start, start + messageLength);
        buffer = buffer.slice(start + messageLength);

        const decoded = decodeNdgrMessage(messageBytes);
        if (decoded && Object.keys(decoded).length) {
          handleMessage(decoded);
        }
      }
    }

      if (!abortController.signal.aborted) {
        setStatus("NDGRストリームが切断されました 再接続を試行します");
        reconnectTimer = setTimeout(() => connectStream(targetUrl), 1500);
      }
    };

    const handleWatchMessage = (raw) => {
      const text = typeof raw === "string" ? raw : String(raw);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        logNico("watch ws json parse failed", e, text.slice(0, 200));
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

      const candidateUri =
        parsed?.data?.messageServer?.uri ||
        parsed?.data?.viewUri ||
        parsed?.data?.uri ||
        parsed?.messageServer?.uri ||
        parsed?.room?.messageServer?.uri ||
        parsed?.room?.viewUri;

      if (candidateUri) {
        const preview = text.slice(0, 200);
        setStatus(`step2c: watch ws recv messageServer ${preview}`);

        if (candidateUri.includes("mpn.live.nicovideo.jp/api/view")) {
          if (viewUri !== candidateUri || !currentStreamUrl) {
            viewUri = candidateUri;
            setStatus(`step3: ndgr viewUri = ${viewUri}`);
            connectStream(appendAtParam(viewUri));
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

      watchSocket = new WebSocket(watchWsUrl, {
        headers: { "User-Agent": "komebyu/1.0 (+https://github.com/)" },
      });

      watchSocket.on("open", () => {
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
        if (!abortController.signal.aborted) {
          if (watchReconnectTimer) clearTimeout(watchReconnectTimer);
          watchReconnectTimer = setTimeout(openWatchSocket, 2000);
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
