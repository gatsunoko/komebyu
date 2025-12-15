const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const tmi = require("tmi.js");

let win = null;
let client = null;
let currentChannel = null;

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

async function connectTwitch(channelRaw) {
  const channel = String(channelRaw || "").trim().replace(/^#/, "").toLowerCase();
  if (!channel) {
    setStatus("チャンネル名を入力してね");
    return;
  }

  await disconnectTwitch();

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
  await connectTwitch(channel);
});

ipcMain.handle("twitch:disconnect", async () => {
  await disconnectTwitch();
});
