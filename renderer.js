window.addEventListener("DOMContentLoaded", () => {
  const el = {
    channel: document.getElementById("channel"),
    connect: document.getElementById("connect"),
    disconnect: document.getElementById("disconnect"),
    status: document.getElementById("status"),
    list: document.getElementById("list"),
    connections: document.getElementById("connections"),
    ng: document.getElementById("ng"),
    clear: document.getElementById("clear"),
  };

  function setStatus(payload) {
    if (!payload) return;
    if (typeof payload === "string") {
      el.status.textContent = payload;
      return;
    }

    if (payload.global) {
      el.status.textContent = payload.global;
    }
  }

  function buildMessageContent(text, emotes) {
    const fragment = document.createDocumentFragment();
    const content = String(text ?? "");

    const emoteRanges = [];

    if (emotes && typeof emotes === "object") {
      for (const [id, ranges] of Object.entries(emotes)) {
        if (!Array.isArray(ranges)) continue;
        for (const range of ranges) {
          const [startStr, endStr] = String(range || "").split("-");
          const start = Number(startStr);
          const end = Number(endStr);
          if (Number.isInteger(start) && Number.isInteger(end) && start <= end) {
            emoteRanges.push({ start, end, id });
          }
        }
      }
    }

    emoteRanges.sort((a, b) => a.start - b.start);

    let cursor = 0;
    const pushText = (value) => {
      if (value) fragment.append(document.createTextNode(value));
    };

    for (const { start, end, id } of emoteRanges) {
      if (cursor < start) pushText(content.slice(cursor, start));

      const emoteText = content.slice(start, end + 1);
      const img = document.createElement("img");
      img.className = "emote";
      img.src = `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`;
      img.alt = emoteText || `:${id}:`;
      img.loading = "lazy";
      fragment.appendChild(img);

      cursor = end + 1;
    }

    if (cursor < content.length) pushText(content.slice(cursor));

    if (!fragment.childNodes.length) pushText(content);

    return fragment;
  }

  function appendMessage({ user, text, badges, emotes, source }) {
    const ngWords = (el.ng.value || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (ngWords.some((w) => text.includes(w) || user.includes(w))) return;

    const item = document.createElement("div");
    item.className = "msg";

    const from = document.createElement("span");
    from.className = "source";
    from.textContent = source || "unknown";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = user;

    const body = document.createElement("span");
    body.className = "text";
    body.append(": ");
    body.appendChild(buildMessageContent(text, emotes));

    if (badges?.broadcaster) item.classList.add("broadcaster");
    if (badges?.moderator) item.classList.add("moderator");
    if (badges?.subscriber) item.classList.add("subscriber");

    item.appendChild(from);
    item.appendChild(name);
    item.appendChild(body);

    el.list.appendChild(item);
    el.list.scrollTop = el.list.scrollHeight;

    const max = 500;
    while (el.list.children.length > max) el.list.removeChild(el.list.firstChild);
  }

  function renderConnections(list) {
    el.connections.innerHTML = "";

    if (!Array.isArray(list) || list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "connection-status";
      empty.textContent = "接続なし";
      el.connections.appendChild(empty);
      return;
    }

    for (const conn of list) {
      const row = document.createElement("div");
      row.className = "connection-row";

      const info = document.createElement("div");
      info.className = "connection-info";

      const label = document.createElement("div");
      label.className = "connection-label";
      label.textContent = conn.label;

      const status = document.createElement("div");
      status.className = "connection-status";
      status.textContent = conn.status || "接続中";

      info.appendChild(label);
      info.appendChild(status);

      const disconnect = document.createElement("button");
      disconnect.className = "secondary";
      disconnect.textContent = "切断";
      disconnect.addEventListener("click", () => {
        window.twitch.disconnect(conn.id);
      });

      row.appendChild(info);
      row.appendChild(disconnect);
      el.connections.appendChild(row);
    }
  }

  el.connect.addEventListener("click", () => {
    window.twitch.connect(el.channel.value);
  });

  el.disconnect.addEventListener("click", () => {
    window.twitch.disconnect();
  });

  el.clear.addEventListener("click", () => (el.list.innerHTML = ""));

  window.twitch.onEvent(({ type, payload }) => {
    if (type === "status") setStatus(payload);
    if (type === "message") appendMessage(payload);
    if (type === "connections") renderConnections(payload);
  });

  setStatus("未接続");
  renderConnections([]);
});
