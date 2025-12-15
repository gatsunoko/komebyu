const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const tmi = require("tmi.js");

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

  let html;
  try {
    const res = await fetch(watchUrl, {
      headers: {
        "User-Agent": "komebyu/1.0 (+https://github.com/)",
      },
    });

    if (!res.ok) {
      setStatus(`ニコ生取得失敗 (${res.status})`);
      await disconnectConnection(id);
      return;
    }

    html = await res.text();
  } catch (e) {
    setStatus(`ニコ生取得失敗: ${e?.message || String(e)}`);
    await disconnectConnection(id);
    return;
  }

  const propsMatch = html.match(/data-props="([^"]+)"/);
  if (!propsMatch) {
    setStatus("ニコ生の情報が読み取れませんでした (data-props)");
    await disconnectConnection(id);
    return;
  }

  let props;
  try {
    const jsonText = propsMatch[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
    props = JSON.parse(jsonText);
  } catch (e) {
    setStatus(`ニコ生の情報パース失敗: ${e?.message || String(e)}`);
    await disconnectConnection(id);
    return;
  }

  const webSocketUrl =
    props?.site?.watchSession?.webSocketUrl || props?.site?.relive?.webSocketUrl;

  if (!webSocketUrl) {
    setStatus("ニコ生のwebSocketUrlが見つかりませんでした");
    await disconnectConnection(id);
    return;
  }

  const userId = props?.user?.id || "0";

  let watchSocket = null;
  let commentSocket = null;
  let keepSeatTimer = null;

  const cleanup = () => {
    if (watchSocket) {
      try {
        watchSocket.close();
      } catch {}
    }
    if (commentSocket) {
      try {
        commentSocket.close();
      } catch {}
    }
    if (keepSeatTimer) {
      clearInterval(keepSeatTimer);
      keepSeatTimer = null;
    }
    watchSocket = null;
    commentSocket = null;
  };

  connection.disconnect = async () => {
    cleanup();
  };

  try {
    watchSocket = new WebSocket(webSocketUrl);
  } catch (e) {
    setStatus(`ニコ生への接続開始失敗: ${e?.message || String(e)}`);
    await disconnectConnection(id);
    return;
  }

  updateConnectionStatus(id, "ニコ生: セッション開始中…");

  watchSocket.onopen = () => {
    try {
      watchSocket.send(
        JSON.stringify({
          type: "startWatching",
          data: {
            stream: {
              quality: "abr",
              protocol: "hls",
              latency: "low",
              chasePlay: false,
            },
            room: {
              protocol: "websocket",
              commentable: true,
            },
            reconnect: false,
          },
        })
      );
      keepSeatTimer = setInterval(() => {
        try {
          watchSocket?.send?.(
            JSON.stringify({
              type: "keepSeat",
            })
          );
        } catch {}
      }, 60 * 1000);
    } catch (e) {
      setStatus(`ニコ生: startWatching送信失敗 ${e?.message || String(e)}`);
    }
  };

  function startCommentSocket(messageServer) {
    if (!messageServer?.uri || !messageServer?.threadId) {
      setStatus("ニコ生: コメントサーバー情報が不足しています");
      return;
    }

    try {
      commentSocket = new WebSocket(messageServer.uri, "msg.nicovideo.jp#json");
    } catch (e) {
      setStatus(`ニコ生: コメント接続失敗 ${e?.message || String(e)}`);
      return;
    }

    const threadId = String(messageServer.threadId);

    commentSocket.onopen = () => {
      updateConnectionStatus(id, `コメント接続完了 (${threadId})`);
      const payloads = [
        { ping: { content: "rs:0" } },
        {
          thread: {
            thread: threadId,
            version: "20090904",
            res_from: -150,
            with_global: 1,
            scores: 1,
            user_id: String(userId),
          },
        },
        { ping: { content: "rf:0" } },
      ];
      for (const p of payloads) {
        try {
          commentSocket.send(JSON.stringify(p));
        } catch {}
      }
    };

    commentSocket.onmessage = (event) => {
      const lines = String(event.data || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      for (const line of lines) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        if (parsed?.ping) continue;
        if (parsed?.thread) continue;
        const chat = parsed?.chat;
        if (!chat?.content) continue;

        send("message", {
          connectionId: id,
          source: connection.label,
          user: chat.mail || chat.user_id || "niconico",
          text: chat.content,
          badges: {},
          emotes: null,
        });
      }
    };

    commentSocket.onerror = (e) => {
      setStatus(`ニコ生コメントエラー: ${e?.message || String(e)}`);
    };

    commentSocket.onclose = () => {
      updateConnectionStatus(id, "コメント切断");
      disconnectConnection(id);
    };
  }

  watchSocket.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data.type === "ping") {
      try {
        watchSocket.send(JSON.stringify({ type: "pong" }));
      } catch {}
      return;
    }

    if (data.type === "seat") {
      updateConnectionStatus(id, "座席確保");
      return;
    }

    if (data.type === "error") {
      setStatus(`ニコ生エラー: ${data?.data?.code || "unknown"}`);
      disconnectConnection(id);
      return;
    }

    if (data.type === "room") {
      const messageServer = data.data?.messageServer || data.data;
      const threadId = data.data?.threadId;
      startCommentSocket({ ...messageServer, threadId });
      return;
    }

    if (data.type === "disconnect") {
      updateConnectionStatus(id, "切断");
      disconnectConnection(id);
      return;
    }
  };

  watchSocket.onerror = (e) => {
    setStatus(`ニコ生エラー: ${e?.message || String(e)}`);
  };

  watchSocket.onclose = () => {
    updateConnectionStatus(id, "切断");
    disconnectConnection(id);
  };
}

async function connectTwitch(channelRaw) {
  const channel = String(channelRaw || "").trim().replace(/^#/, "").toLowerCase();
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
