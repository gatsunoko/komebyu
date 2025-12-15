window.addEventListener("DOMContentLoaded", () => {
  const el = {
    channel: document.getElementById("channel"),
    connect: document.getElementById("connect"),
    disconnect: document.getElementById("disconnect"),
    status: document.getElementById("status"),
    list: document.getElementById("list"),
    ng: document.getElementById("ng"),
    clear: document.getElementById("clear"),
  };

  function setStatus(text) {
    el.status.textContent = text;
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

  function appendMessage({ user, text, badges, emotes }) {
    const ngWords = (el.ng.value || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (ngWords.some((w) => text.includes(w) || user.includes(w))) return;

    const item = document.createElement("div");
    item.className = "msg";

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

    item.appendChild(name);
    item.appendChild(body);

    el.list.appendChild(item);
    el.list.scrollTop = el.list.scrollHeight;

    const max = 500;
    while (el.list.children.length > max) el.list.removeChild(el.list.firstChild);
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
  });

  setStatus("未接続");
});
