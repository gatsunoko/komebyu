const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const tmi = require("tmi.js");

let win = null;
let client = null;
let currentChannel = null;
let nicoWatchSocket = null;
let nicoCommentSocket = null;
let nicoKeepSeatTimer = null;

function send(type, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send("twitch:event", { type, payload });
  }
}

function setStatus(text) {
  send("status", text);
  console.log("[status]", text);
}

async function disconnectTwitch() {
  if (!client) {
    setStatus("未接続");
    return;
  }
  try {
    await client.disconnect();
  } catch {}
  client = null;
  currentChannel = null;
  setStatus("未接続");
}

async function disconnectNiconico() {
  if (nicoWatchSocket) {
    try {
      nicoWatchSocket.close();
    } catch {}
  }
  if (nicoCommentSocket) {
    try {
      nicoCommentSocket.close();
    } catch {}
  }
  if (nicoKeepSeatTimer) {
    clearInterval(nicoKeepSeatTimer);
    nicoKeepSeatTimer = null;
  }
  nicoWatchSocket = null;
  nicoCommentSocket = null;
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

  await disconnectTwitch();
  await disconnectNiconico();

  setStatus(`ニコ生に接続中… ${liveId}`);

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
      return;
    }

    html = await res.text();
  } catch (e) {
    setStatus(`ニコ生取得失敗: ${e?.message || String(e)}`);
    return;
  }

  const propsMatch = html.match(/data-props="([^"]+)"/);
  if (!propsMatch) {
    setStatus("ニコ生の情報が読み取れませんでした (data-props)");
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
    return;
  }

  const webSocketUrl =
    props?.site?.watchSession?.webSocketUrl || props?.site?.relive?.webSocketUrl;

  if (!webSocketUrl) {
    setStatus("ニコ生のwebSocketUrlが見つかりませんでした");
    return;
  }

  const userId = props?.user?.id || "0";

  try {
    nicoWatchSocket = new WebSocket(webSocketUrl);
  } catch (e) {
    setStatus(`ニコ生への接続開始失敗: ${e?.message || String(e)}`);
    return;
  }

  setStatus("ニコ生: セッション開始中…");

  nicoWatchSocket.onopen = () => {
    try {
      nicoWatchSocket.send(
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
      nicoKeepSeatTimer = setInterval(() => {
        try {
          nicoWatchSocket?.send?.(
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
      nicoCommentSocket = new WebSocket(messageServer.uri);
    } catch (e) {
      setStatus(`ニコ生: コメント接続失敗 ${e?.message || String(e)}`);
      return;
    }

    const threadId = String(messageServer.threadId);

    nicoCommentSocket.onopen = () => {
      setStatus(`ニコ生: コメント接続完了 (${threadId})`);
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
          nicoCommentSocket.send(JSON.stringify(p));
        } catch {}
      }
    };

    nicoCommentSocket.onmessage = (event) => {
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
          user: chat.mail || chat.user_id || "niconico",
          text: chat.content,
          badges: {},
        });
      }
    };

    nicoCommentSocket.onerror = (e) => {
      setStatus(`ニコ生コメントエラー: ${e?.message || String(e)}`);
    };

    nicoCommentSocket.onclose = () => {
      setStatus("ニコ生コメント切断");
    };
  }

  nicoWatchSocket.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data.type === "ping") {
      try {
        nicoWatchSocket.send(JSON.stringify({ type: "pong" }));
      } catch {}
      return;
    }

    if (data.type === "seat") {
      setStatus("ニコ生: 座席確保");
      return;
    }

    if (data.type === "error") {
      setStatus(`ニコ生エラー: ${data?.data?.code || "unknown"}`);
      return;
    }

    if (data.type === "room") {
      startCommentSocket(data.data?.messageServer || data.data);
      return;
    }

    if (data.type === "disconnect") {
      setStatus("ニコ生切断");
      return;
    }
  };

  nicoWatchSocket.onerror = (e) => {
    setStatus(`ニコ生エラー: ${e?.message || String(e)}`);
  };

  nicoWatchSocket.onclose = () => {
    setStatus("ニコ生切断");
  };
}

async function connectTwitch(channelRaw) {
  const channel = String(channelRaw || "").trim().replace(/^#/, "").toLowerCase();
  if (!channel) {
    setStatus("チャンネル名を入力してね");
    return;
  }

  await disconnectTwitch();
  await disconnectNiconico();

  setStatus(`接続中… #${channel}`);

  currentChannel = channel;
  client = new tmi.Client({
    options: { debug: true }, // ← 何か起きた時にログが出る
    connection: { reconnect: true, secure: true },
    channels: [channel],
  });

  client.on("connected", (_addr, _port) => setStatus(`接続中: #${channel}`));
  client.on("reconnect", () => setStatus("再接続中…"));
  client.on("reconnect_failed", () => setStatus("再接続失敗"));
  client.on("disconnected", (reason) => setStatus(`切断: ${reason || "unknown"}`));

  client.on("notice", (_chan, msgid, message) => {
    // BAN/サスペンド/参加不可などはここに出ます
    setStatus(`NOTICE: ${msgid} ${message}`);
  });

  client.on("message", (_channel, tags, message, self) => {
    if (self) return;
    send("message", {
      user: tags["display-name"] || tags.username || "unknown",
      text: message,
      badges: tags.badges || {},
    });
  });

  client.on("error", (err) => {
    setStatus(`ERROR: ${err?.message || String(err)}`);
  });

  try {
    await client.connect();
  } catch (e) {
    setStatus(`接続失敗 catch: ${e?.message || String(e)}`);
    client = null;
    currentChannel = null;
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
  await disconnectTwitch();
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("twitch:connect", async (_e, channel) => {
  await connectAuto(channel);
});

ipcMain.handle("twitch:disconnect", async () => {
  await disconnectTwitch();
  await disconnectNiconico();
});
