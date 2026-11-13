
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function send(ws, data) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  } catch {}
}

function broadcast(sockets, data, except = null) {
  for (const ws of sockets) {
    if (ws !== except) send(ws, data);
  }
}

export class RadioRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("RADIO LINK room ready");
    }

    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "Misafir").slice(0, 24);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const peers = this.ctx.getWebSockets().map(ws =>
      ws.deserializeAttachment() || {}
    );

    const id = crypto.randomUUID();

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, name });

    send(server, {
      type: "welcome",
      id,
      peers
    });

    broadcast(this.ctx.getWebSockets(), {
      type: "peer-joined",
      id,
      name
    }, server);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  webSocketMessage(ws, message) {
    let data;

    try {
      data = JSON.parse(String(message));
    } catch {
      return;
    }

    const sender = ws.deserializeAttachment() || {};

    if (data.type === "chat") {
      const text = String(data.text || "").slice(0, 1000);
      if (!text.trim()) return;

      broadcast(this.ctx.getWebSockets(), {
        type: "chat",
        id: sender.id,
        name: sender.name,
        text,
        time: Date.now()
      });
    }

    if (data.type === "signal") {
      const target = String(data.target || "");
      const peer = this.ctx.getWebSockets().find(s => {
        const info = s.deserializeAttachment() || {};
        return info.id === target;
      });

      if (peer) {
        send(peer, {
          type: "signal",
          from: sender.id,
          signal: data.signal
        });
      }
    }
  }

  webSocketClose(ws) {
    const info = ws.deserializeAttachment() || {};

    broadcast(this.ctx.getWebSockets(), {
      type: "peer-left",
      id: info.id,
      name: info.name
    });
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Upgrade"
        }
      });
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        app: "RADIO LINK",
        version: "2.1"
      });
    }

    if (url.pathname === "/api/create" && request.method === "POST") {
      const code = crypto.randomUUID()
        .replace(/-/g, "")
        .slice(0, 6)
        .toUpperCase();

      return json({ ok: true, code });
    }

    const match = url.pathname.match(/^\/api\/room\/([A-Z0-9]{4,10})$/i);

    if (match) {
      const code = match[1].toUpperCase();
      const id = env.ROOMS.idFromName(code);
      const room = env.ROOMS.get(id);
      return room.fetch(request);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("RADIO LINK");
  }
};
