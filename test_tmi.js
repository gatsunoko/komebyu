const tmi = require("tmi.js");

const channel = process.argv[2] || "twitch";

const client = new tmi.Client({
  connection: { reconnect: true, secure: true },
  channels: [channel],
});

client.on("connected", (addr, port) => console.log("connected", addr, port));
client.on("reconnect", () => console.log("reconnect..."));
client.on("disconnected", (reason) => console.log("disconnected", reason));
client.on("notice", (_c, id, msg) => console.log("notice", id, msg));
client.on("error", (e) => console.log("error", e));

client.connect().catch(e => console.log("connect catch", e));
