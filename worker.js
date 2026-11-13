
function json(data,status=200){
 return new Response(JSON.stringify(data),{
  status,
  headers:{
   "Content-Type":"application/json",
   "Access-Control-Allow-Origin":"*",
   "Access-Control-Allow-Methods":"GET,POST,PUT,DELETE,OPTIONS",
   "Access-Control-Allow-Headers":"Content-Type"
  }
 });
}
function send(ws,data){
 try{if(ws.readyState===1)ws.send(JSON.stringify(data))}catch{}
}
function broadcast(sockets,data,except=null){
 for(const ws of sockets)if(ws!==except)send(ws,data);
}
function safeRoom(v){
 return /^[A-Z0-9]{4,10}$/i.test(v||"");
}
function validKey(room,key){
 return typeof key==="string"&&key.startsWith("rooms/"+room+"/")&&
  !key.includes("..")&&key.length<300;
}
function corsHeaders(extra={}){
 return {
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Methods":"GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers":"Content-Type",
  ...extra
 };
}

export class RadioRoom{
 constructor(ctx,env){this.ctx=ctx;this.env=env}
 async fetch(request){
  if(request.headers.get("Upgrade")!=="websocket")
   return new Response("RADIO LINK room ready");

  const url=new URL(request.url);
  const name=(url.searchParams.get("name")||"Misafir").slice(0,24);
  const pair=new WebSocketPair();
  const client=pair[0],server=pair[1];
  const peers=this.ctx.getWebSockets().map(ws=>ws.deserializeAttachment()||{});
  const id=crypto.randomUUID();

  this.ctx.acceptWebSocket(server);
  server.serializeAttachment({id,name});
  send(server,{type:"welcome",id,peers});
  broadcast(this.ctx.getWebSockets(),{type:"peer-joined",id,name},server);

  return new Response(null,{status:101,webSocket:client});
 }
 webSocketMessage(ws,message){
  let data;
  try{data=JSON.parse(String(message))}catch{return}
  const sender=ws.deserializeAttachment()||{};

  if(data.type==="chat"){
   const text=String(data.text||"").slice(0,1000);
   if(!text.trim())return;
   broadcast(this.ctx.getWebSockets(),{
    type:"chat",id:sender.id,name:sender.name,text,time:Date.now()
   });
  }

  if(data.type==="signal"){
   const target=String(data.target||"");
   const peer=this.ctx.getWebSockets().find(s=>
    (s.deserializeAttachment()||{}).id===target
   );
   if(peer)send(peer,{type:"signal",from:sender.id,signal:data.signal});
  }
 }
 webSocketClose(ws){
  const info=ws.deserializeAttachment()||{};
  broadcast(this.ctx.getWebSockets(),{
   type:"peer-left",id:info.id,name:info.name
  });
 }
 webSocketError(ws){this.webSocketClose(ws)}
}

export default{
 async fetch(request,env){
  const url=new URL(request.url);
  const path=url.pathname;

  if(request.method==="OPTIONS")
   return new Response(null,{headers:corsHeaders()});

  if(path==="/api/health")
   return json({ok:true,app:"RADIO LINK",version:"3.0"});

  if(path==="/api/create"&&request.method==="POST"){
   const code=crypto.randomUUID().replace(/-/g,"").slice(0,6).toUpperCase();
   return json({ok:true,code});
  }

  /* R2: multipart upload başlat */
  if(path==="/api/files/create"&&request.method==="POST"){
   if(!env.FILES)return json({error:"R2 FILES binding eksik"},503);
   try{
    const b=await request.json();
    const room=String(b.room||"").toUpperCase();
    const name=String(b.name||"Dosya").slice(0,180);
    const size=Number(b.size||0);
    const type=String(b.type||"application/octet-stream").slice(0,120);

    if(!safeRoom(room))return json({error:"Geçersiz oda"},400);
    if(!Number.isFinite(size)||size<=0||size>2.5*1024*1024*1024)
     return json({error:"Dosya 2,5 GB sınırını aşıyor"},413);

    const key="rooms/"+room+"/"+crypto.randomUUID();
    const upload=await env.FILES.createMultipartUpload(key,{
     httpMetadata:{contentType:type},
     customMetadata:{room,name,size:String(size),type}
    });
    return json({ok:true,key,uploadId:upload.uploadId});
   }catch(e){return json({error:String(e)},500)}
  }

  /* R2: dosya parçası yükle */
  if(path==="/api/files/part"&&request.method==="PUT"){
   if(!env.FILES)return json({error:"R2 binding eksik"},503);
   const room=String(url.searchParams.get("room")||"").toUpperCase();
   const key=url.searchParams.get("key");
   const uploadId=url.searchParams.get("uploadId");
   const partNumber=Number(url.searchParams.get("partNumber"));

   if(!safeRoom(room)||!validKey(room,key)||!uploadId||
      !Number.isInteger(partNumber)||partNumber<1||partNumber>10000||
      !request.body)return json({error:"Eksik veya geçersiz parça bilgisi"},400);

   try{
    const upload=env.FILES.resumeMultipartUpload(key,uploadId);
    const part=await upload.uploadPart(partNumber,request.body);
    return json({ok:true,part});
   }catch(e){return json({error:String(e)},400)}
  }

  /* R2: parçaları birleştir */
  if(path==="/api/files/complete"&&request.method==="POST"){
   if(!env.FILES)return json({error:"R2 binding eksik"},503);
   try{
    const b=await request.json();
    const room=String(b.room||"").toUpperCase();
    if(!safeRoom(room)||!validKey(room,b.key)||!b.uploadId||
       !Array.isArray(b.parts)||!b.parts.length)
     return json({error:"Eksik dosya bilgisi"},400);

    const upload=env.FILES.resumeMultipartUpload(b.key,b.uploadId);
    const obj=await upload.complete(b.parts);
    return json({ok:true,key:obj.key,size:obj.size});
   }catch(e){return json({error:String(e)},400)}
  }

  /* R2: odadaki dosyaları listele */
  if(path==="/api/files/list"&&request.method==="GET"){
   if(!env.FILES)return json({error:"R2 binding eksik"},503);
   const room=String(url.searchParams.get("room")||"").toUpperCase();
   if(!safeRoom(room))return json({error:"Geçersiz oda"},400);
   try{
    const result=await env.FILES.list({prefix:"rooms/"+room+"/",limit:100});
    const files=result.objects.map(o=>({
     key:o.key,
     name:o.customMetadata?.name||"Dosya",
     size:o.size,
     type:o.httpMetadata?.contentType||"application/octet-stream",
     uploaded:o.uploaded
    }));
    return json({ok:true,files});
   }catch(e){return json({error:String(e)},500)}
  }

  /* R2: dosyayı akış olarak indir veya önbelleğe al */
  if(path==="/api/files/download"&&request.method==="GET"){
   if(!env.FILES)return json({error:"R2 binding eksik"},503);
   const room=String(url.searchParams.get("room")||"").toUpperCase();
   const key=url.searchParams.get("key");
   if(!safeRoom(room)||!validKey(room,key))
    return json({error:"Geçersiz dosya adresi"},400);

   try{
    const obj=await env.FILES.get(key);
    if(!obj)return json({error:"Dosya bulunamadı"},404);

    const name=obj.customMetadata?.name||"download";
    const headers=new Headers(corsHeaders({
     "Content-Type":obj.httpMetadata?.contentType||"application/octet-stream",
     "Content-Length":String(obj.size),
     "Content-Disposition":"attachment; filename*=UTF-8''"+encodeURIComponent(name),
     "Cache-Control":"private, max-age=3600"
    }));
    return new Response(obj.body,{headers});
   }catch(e){return json({error:String(e)},500)}
  }

  /* R2: yarım kalan yüklemeyi iptal et */
  if(path==="/api/files/abort"&&request.method==="DELETE"){
   if(!env.FILES)return json({error:"R2 binding eksik"},503);
   const room=String(url.searchParams.get("room")||"").toUpperCase();
   const key=url.searchParams.get("key");
   const uploadId=url.searchParams.get("uploadId");
   if(!safeRoom(room)||!validKey(room,key)||!uploadId)
    return json({error:"Eksik bilgi"},400);
   try{
    await env.FILES.resumeMultipartUpload(key,uploadId).abort();
    return json({ok:true});
   }catch(e){return json({error:String(e)},400)}
  }

  const match=path.match(/^\/api\/room\/([A-Z0-9]{4,10})$/i);
  if(match){
   const code=match[1].toUpperCase();
   const id=env.ROOMS.idFromName(code);
   return env.ROOMS.get(id).fetch(request);
  }

  if(env.ASSETS)return env.ASSETS.fetch(request);
  return new Response("RADIO LINK");
 }
};
