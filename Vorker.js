
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Upgrade"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors }
  });
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

    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({
      type: "system",
      text: "Odaya bağlandın!"
    }));

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);

      if (data.type === "chat") {
        const packet = JSON.stringify({
          type: "chat",
          name: String(data.name || "Misafir").slice(0, 24),
          text: String(data.text || "").slice(0, 1000)
        });

        for (const socket of this.ctx.getWebSockets()) {
          try {
            socket.send(packet);
          } catch {}
        }
      }
    } catch {}
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true, app: "RADIO LINK" });
    }

    if (url.pathname === "/api/create" && request.method === "POST") {
      const code = crypto.randomUUID()
        .replace(/-/g, "")
        .slice(0, 6)
        .toUpperCase();

      return json({ ok: true, code });
    }

    const match = url.pathname.match(
      /^\/api\/room\/([A-Z0-9]{4,10})$/i
    );

    if (match) {
      const id = env.ROOMS.idFromName(match[1].toUpperCase());
      return env.ROOMS.get(id).fetch(request);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("RADIO LINK çalışıyor.");
  }
};
