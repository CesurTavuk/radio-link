
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function validRoom(room) {
  return typeof room === "string" &&
    /^[A-Z0-9]{4,12}$/.test(room);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/health") {
        return json({
          ok: true,
          app: "RADIO LINK",
          version: "3.0"
        });
      }

      if (path === "/api/create" && request.method === "POST") {
        const code = crypto.randomUUID()
          .replace(/-/g, "")
          .slice(0, 6)
          .toUpperCase();

        return json({ ok: true, code });
      }

      if (path.startsWith("/api/room/")) {
        const code = path.split("/").pop().toUpperCase();

        if (!validRoom(code)) {
          return json({
            error: "Geçersiz oda kodu"
          }, 400);
        }

        if (request.headers.get("Upgrade") !== "websocket") {
          return json({
            error: "WebSocket bağlantısı gerekli"
          }, 426);
        }

        const id = env.ROOMS.idFromName(code);
        const room = env.ROOMS.get(id);

        return room.fetch(request);
      }

      return env.ASSETS.fetch(request);

    } catch (error) {
      return json({
        error: error?.message || "Sunucu hatası"
      }, 500);
    }
  }
};

export class RadioRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket gerekli", {
        status: 426
      });
    }

    const url = new URL(request.url);

    const name = String(
      url.searchParams.get("name") || "Misafir"
    ).replace(/[<>]/g, "").slice(0, 24);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();

    const id = crypto.randomUUID();

    const oldPeers = [...this.sessions.entries()].map(
      ([peerId, peer]) => ({
        id: peerId,
        name: peer.name
      })
    );

    this.sessions.set(id, {
      ws: server,
      name
    });

    server.send(JSON.stringify({
      type: "welcome",
      id,
      peers: oldPeers
    }));

    this.broadcast({
      type: "peer-joined",
      peer: { id, name }
    }, id);

    server.addEventListener("message", event => {
      this.onMessage(id, event.data);
    });

    server.addEventListener("close", () => {
      this.removePeer(id);
    });

    server.addEventListener("error", () => {
      this.removePeer(id);
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  onMessage(id, raw) {
    const sender = this.sessions.get(id);
    if (!sender) return;

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === "chat") {
      const message = String(
        data.message || ""
      ).slice(0, 4000);

      if (!message.trim()) return;

      this.broadcast({
        type: "chat",
        name: sender.name,
        message
      });

      return;
    }

    if (data.type === "signal") {
      const targetId = String(data.to || "");
      const target = this.sessions.get(targetId);

      if (!target || !data.signal) return;

      try {
        target.ws.send(JSON.stringify({
          type: "signal",
          from: id,
          signal: data.signal
        }));
      } catch {
        this.removePeer(targetId);
      }
    }
  }

  broadcast(data, exceptId = null) {
    const message = JSON.stringify(data);

    for (const [id, peer] of this.sessions) {
      if (id === exceptId) continue;

      try {
        peer.ws.send(message);
      } catch {
        this.removePeer(id);
      }
    }
  }

  removePeer(id) {
    if (!this.sessions.has(id)) return;

    this.sessions.delete(id);

    this.broadcast({
      type: "peer-left",
      id
    });
  }
}
