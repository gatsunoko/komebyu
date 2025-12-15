const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("twitch", {
  connect: (channel) => ipcRenderer.invoke("twitch:connect", channel),
  disconnect: (id) => ipcRenderer.invoke("twitch:disconnect", id),
  onEvent: (handler) => {
    ipcRenderer.on("twitch:event", (_e, data) => handler(data));
  },
});
