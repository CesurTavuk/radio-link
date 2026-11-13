const MAX_FILE_SIZE = 2.5 * 1024 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function validRoom(room) {
  return typeof room === "string" &&
    /^[A-Z0-9]{4,12}$/.test(room);
}

function safeFilename(name) {
  return String(name || "dosya").replace(/[\\/\r\n"]/g, "_").slice(0, 180);
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
          return json({ error: "Geçersiz oda kodu" }, 400);
        }

        if (request.headers.get("Upgrade") !== "websocket") {
          return json({ error: "WebSocket bağlantısı gerekli" }, 426);
        }

        const id = env.ROOMS.idFromName(code);
        const room = env.ROOMS.get(id);
        return room.fetch(request);
      }

      if (!env.FILES) {
        return json({ error: "Cloudflare R2 FILES bağlantısı yapılandırılmamış" }, 500);
      }

      /* Multipart yüklemeyi başlat */

      if (path === "/api/files/start" && request.method === "POST") {
        const data = await request.json();

        const room = String(data.room || "").toUpperCase();
        const name = safeFilename(data.name);
        const size = Number(data.size);
        const type = String(data.type || "application/octet-stream");

        if (!validRoom(room)) {
          return json({ error: "Geçersiz oda kodu" }, 400);
        }

        if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_SIZE) {
          return json({ error: "Dosya boyutu 0 ile 2.5 GiB arasında olmalı" }, 400);
        }

        const key = `${room}/${crypto.randomUUID()}`;

        const upload = await env.FILES.createMultipartUpload(key, {
          httpMetadata: {
            contentType: type
          },
          customMetadata: {
            room,
            name,
            size: String(size)
          }
        });

        return json({
          ok: true,
          key,
          uploadId: upload.uploadId
        });
      }

      /* Tek bir dosya parçasını yükle */

      if (path === "/api/files/part" && request.method === "PUT") {
        const room = String(url.searchParams.get("room") || "").toUpperCase();
        const key = url.searchParams.get("key");
        const uploadId = url.searchParams.get("uploadId");
        const partNumber = Number(url.searchParams.get("partNumber"));

        if (!validRoom(room) || !key || !key.startsWith(room + "/")) {
          return json({ error: "Dosya erişimi reddedildi" }, 403);
        }

        if (!uploadId || !Number.isInteger(partNumber) ||
            partNumber < 1 || partNumber > 10000) {
          return json({ error: "Geçersiz parça bilgisi" }, 400);
        }

        const body = await request.arrayBuffer();

        if (body.byteLength === 0 || body.byteLength > 10 * 1024 * 1024) {
          return json({ error: "Parça boyutu geçersiz" }, 400);
        }

        const upload = env.FILES.resumeMultipartUpload(key, uploadId);
        const result = await upload.uploadPart(partNumber, body);

        return json({
          ok: true,
          partNumber,
          etag: result.etag
        });
      }

      /* Parçaları birleştirip dosyayı tamamla */

      if (path === "/api/files/finish" && request.method === "POST") {
        const data = await request.json();

        const room = String(data.room || "").toUpperCase();
        const key = String(data.key || "");
        const uploadId = String(data.uploadId || "");
        const parts = data.parts;

        if (!validRoom(room) || !key.startsWith(room + "/")) {
          return json({ error: "Dosya erişimi reddedildi" }, 403);
        }

        if (!uploadId || !Array.isArray(parts) || parts.length < 1) {
          return json({ error: "Eksik parça bilgisi" }, 400);
        }

        if (parts.length > 300) {
          return json({ error: "Parça sayısı sınırı aşıldı" }, 400);
        }

        const cleanParts = parts.map(part => ({
          partNumber: Number(part.partNumber),
          etag: String(part.etag || "")
        }));

        cleanParts.sort((a, b) => a.partNumber - b.partNumber);

        for (let i = 0; i < cleanParts.length; i++) {
          if (
            cleanParts[i].partNumber !== i + 1 ||
            !cleanParts[i].etag
          ) {
            return json({ error: "Parça listesi geçersiz" }, 400);
          }
        }

        const upload = env.FILES.resumeMultipartUpload(key, uploadId);
        const object = await upload.complete(cleanParts);

        return json({
          ok: true,
          key: object.key,
          size: object.size
        });
      }

      /* Odaya ait dosyaları listele */

      if (path === "/api/files" && request.method === "GET") {
        const room = String(url.searchParams.get("room") || "").toUpperCase();

        if (!validRoom(room)) {
          return json({ error: "Geçersiz oda kodu" }, 400);
        }

        const listed = await env.FILES.list({
          prefix: room + "/",
          include: ["customMetadata", "httpMetadata"],
          limit: 1000
        });

        const files = listed.objects.map(object => ({
          id: object.key,
          name: object.customMetadata?.name || object.key.split("/").pop(),
          size: object.size,
          uploaded: object.uploaded
        }));

        return json({ ok: true, files });
      }

      /* Dosyayı indir */

      if (path === "/api/files/download" && request.method === "GET") {
        const room = String(url.searchParams.get("room") || "").toUpperCase();
        const key = url.searchParams.get("key");

        if (!validRoom(room) || !key || !key.startsWith(room + "/")) {
          return json({ error: "Dosya erişimi reddedildi" }, 403);
        }

        const object = await env.FILES.get(key);

        if (!object || object.customMetadata?.room !== room) {
          return json({ error: "Dosya bulunamadı" }, 404);
        }

        const filename = safeFilename(object.customMetadata?.name || "dosya");

        return new Response(object.body, {
          headers: {
            "Content-Type": object.httpMetadata?.contentType ||
              "application/octet-stream",
            "Content-Length": String(object.size),
            "Content-Disposition":
              `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
            "Cache-Control": "private, max-age=0"
          }
        });
      }

      return env.ASSETS.fetch(request);

    } catch (error) {
      return json({
        error: error?.message || "Sunucu hatası"
      }, 500);
    }
  }
};


/* RADIO LINK oda sunucusu */

export class RadioRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket gerekli", { status: 426 });
    }

    const url = new URL(request.url);
    const name = String(url.searchParams.get("name") || "Misafir")
      .replace(/[<>]/g, "")
      .slice(0, 24);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();

    const id = crypto.randomUUID();

    const oldPeers = [...this.sessions.entries()].map(([peerId, peer]) => ({
      id: peerId,
      name: peer.name
    }));

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
      const message = String(data.message || "").slice(0, 4000);
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
