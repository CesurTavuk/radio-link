const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Upgrade"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...cors
    }
  });
}

function send(ws, data) {
  try {
    ws.send(JSON.stringify(data));
  } catch {}
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

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const peers = this.ctx.getWebSockets().map(ws => {
      return ws.deserializeAttachment() || {};
    });

    const id = crypto.randomUUID();

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      id,
      name: "Misafir"
    });

    send(server, {
      type: "welcome",
      id,
      peers
    });

    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== server) {
        send(ws, {
          type: "peer-joined",
          id
        });
      }
    }

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(String(message));
      const sender = ws.deserializeAttachment() || {};

      if (data.type === "chat") {
        const name = String(data.name || "Misafir").slice(0, 24);
        const text = String(data.text || "").slice(0, 1000);

        if (!text.trim()) return;

        ws.serializeAttachment({
          ...sender,
          name
        });

        const packet = {
          type: "chat",
          id: sender.id,
          name,
          text,
          time: Date.now()
        };

        for (const socket of this.ctx.getWebSockets()) {
          send(socket, packet);
        }
      }

      if (data.type === "signal") {
        const target = String(data.target || "");
        const signal = data.signal;

        if (!target || !signal || typeof signal !== "object") return;

        for (const socket of this.ctx.getWebSockets()) {
          if (socket === ws) continue;

          const peer = socket.deserializeAttachment() || {};

          if (peer.id === target) {
            send(socket, {
              type: "signal",
              from: sender.id,
              signal
            });
            break;
          }
        }
      }
    } catch {}
  }

  webSocketClose(ws) {
    const attachment = ws.deserializeAttachment() || {};

    for (const socket of this.ctx.getWebSockets()) {
      send(socket, {
        type: "peer-left",
        id: attachment.id
      });
    }
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
        status: 204,
        headers: cors
      });
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        app: "RADIO LINK",
        version: "2.0"
      });
    }

    if (url.pathname === "/api/create" && request.method === "POST") {
      const code = crypto.randomUUID()
        .replace(/-/g, "")
        .slice(0, 6)
        .toUpperCase();

      return json({
        ok: true,
        code
      });
    }

    const match = url.pathname.match(
      /^\/api\/room\/([A-Z0-9]{4,10})$/i
    );

    if (match) {
      const id = env.ROOMS.idFromName(
        match[1].toUpperCase()
      );

      return env.ROOMS.get(id).fetch(request);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("RADIO LINK çalışıyor.");
  }
};
