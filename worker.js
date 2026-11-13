export default {
 async fetch(request,env){
  const url=new URL(request.url);
  const path=url.pathname;

  if(path==="/api/health"){
   return Response.json({ok:true,app:"RADIO LINK"});
  }

  if(path==="/api/create"&&request.method==="POST"){
   const code=Math.random().toString(36).substring(2,8).toUpperCase();
   return Response.json({code});
  }

  if(path.startsWith("/api/room/")){
   const code=path.split("/").pop();
   const id=env.ROOMS.idFromName(code);
   const room=env.ROOMS.get(id);
   return room.fetch(request);
  }

  if(path==="/api/files/start"&&request.method==="POST"){
   if(!env.FILES)return new Response("R2 binding FILES eksik",{status:500});

   const data=await request.json();
   if(!data.room||!data.name||data.size>2.5*1024*1024*1024){
    return new Response("Geçersiz dosya",{status:400});
   }

   const key=`${data.room}/${crypto.randomUUID()}-${data.name}`;
   const upload=await env.FILES.createMultipartUpload(key,{
    httpMetadata:{contentType:data.type||"application/octet-stream"},
    customMetadata:{room:data.room,name:data.name}
   });

   return Response.json({id:upload.uploadId,key});
  }

  if(path.startsWith("/api/files/part/")&&request.method==="PUT"){
   const parts=path.split("/");
   const uploadId=parts[4];
   const partNumber=Number(parts[5]);
   const room=url.searchParams.get("room");

   const body=await request.arrayBuffer();
   const keyPrefix=`${room}/`;

   const listed=await env.FILES.list({prefix:keyPrefix});
   const object=listed.objects.find(o=>o.key.includes(uploadId));

   if(!object){
    return new Response("Upload bulunamadı",{status:404});
   }

   const upload=env.FILES.resumeMultipartUpload(object.key,uploadId);
   const result=await upload.uploadPart(partNumber,body);

   return Response.json({ok:true,partNumber,etag:result.etag});
  }

  if(path.startsWith("/api/files/finish/")&&request.method==="POST"){
   const uploadId=path.split("/").pop();
   const data=await request.json();
   const listed=await env.FILES.list({prefix:`${data.room}/`});
   const object=listed.objects.find(o=>o.key.includes(uploadId));

   if(!object)return new Response("Dosya bulunamadı",{status:404});

   const upload=env.FILES.resumeMultipartUpload(object.key,uploadId);

   return new Response("Multipart tamamlamak için parça ETag listesi gerekir.",{
    status:501
   });
  }

  if(path==="/api/files"){
   const room=url.searchParams.get("room");
   const listed=await env.FILES.list({prefix:`${room}/`});
   return Response.json({
    files:listed.objects.map(o=>({
     id:o.key,
     name:o.key.split("/").pop(),
     size:o.size
    }))
   });
  }

  if(path.startsWith("/api/files/download/")){
   const key=decodeURIComponent(path.split("/api/files/download/")[1]);
   const room=url.searchParams.get("room");

   if(!key.startsWith(room+"/")){
    return new Response("Erişim reddedildi",{status:403});
   }

   const object=await env.FILES.get(key);
   if(!object)return new Response("Dosya bulunamadı",{status:404});

   return new Response(object.body,{
    headers:{
     "Content-Type":object.httpMetadata?.contentType||"application/octet-stream",
     "Content-Disposition":`attachment; filename="${key.split("/").pop()}"`
    }
   });
  }

  return env.ASSETS.fetch(request);
 }
};

export class RadioRoom {
 constructor(state,env){
  this.state=state;
  this.env=env;
  this.sessions=new Map();
 }

 async fetch(request){
  const url=new URL(request.url);
  if(url.pathname.endsWith("/room")||url.pathname.includes("/api/room/")){
   if(request.headers.get("Upgrade")!=="websocket"){
    return new Response("WebSocket gerekli",{status:426});
   }

   const pair=new WebSocketPair();
   const client=pair[0];
   const server=pair[1];

   server.accept();

   const id=crypto.randomUUID();
   const name=url.searchParams.get("name")||"Misafir";

   this.sessions.set(id,{ws:server,name});

   server.serializeAttachment({id,name});

   server.send(JSON.stringify({
    type:"welcome",
    id,
    peers:[...this.sessions.entries()]
     .filter(([peerId])=>peerId!==id)
     .map(([peerId,p])=>({id:peerId,name:p.name}))
   }));

   this.broadcast({
    type:"peer-joined",
    peer:{id,name}
   },id);

   server.addEventListener("message",event=>{
    let data;
    try{data=JSON.parse(event.data)}catch{return}

    if(data.type==="chat"){
     this.broadcast({
      type:"chat",
      name,
      message:String(data.message||"").slice(0,4000)
     });
    }

    if(data.type==="signal"&&data.to){
     const target=this.sessions.get(data.to);
     if(target){
      target.ws.send(JSON.stringify({
       type:"signal",
       from:id,
       signal:data.signal
      }));
     }
    }
   });

   server.addEventListener("close",()=>{
    this.sessions.delete(id);
    this.broadcast({type:"peer-left",id});
   });

   server.addEventListener("error",()=>{
    this.sessions.delete(id);
   });

   return new Response(null,{status:101,webSocket:client});
  }

  return new Response("Not found",{status:404});
 }

 broadcast(data,except){
  const message=JSON.stringify(data);
  for(const [id,peer] of this.sessions){
   if(id===except)continue;
   try{peer.ws.send(message)}catch{}
  }
 }
}
