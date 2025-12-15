const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("twitch", {
  connect: (channel) => ipcRenderer.invoke("twitch:connect", channel),
  disconnect: () => ipcRenderer.invoke("twitch:disconnect"),
  onEvent: (handler) => {
    ipcRenderer.on("twitch:event", (_e, data) => handler(data));
  },
});
