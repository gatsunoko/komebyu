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

  function appendMessage({ user, text, badges }) {
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
    body.textContent = `: ${text}`;

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
