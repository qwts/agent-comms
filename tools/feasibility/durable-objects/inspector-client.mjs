export function controlReady(stream,child,ms=5000) {
 return new Promise((resolve,reject)=>{
  let buffer='',done=false;
  const finish=(error,value)=>{if(done)return;done=true;buffer='';clearTimeout(timer);stream.removeListener('data',receive);child.removeListener('error',failed);child.removeListener('exit',closed);error?reject(error):resolve(value);};
  const failed=error=>finish(error),closed=()=>finish(new Error('workerd-start-failed'));
  const receive=chunk=>{if(Buffer.byteLength(buffer)+chunk.length>65536)return finish(new Error('control-limit'));buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const row=JSON.parse(line);if(row.event==='listen'&&row.socket==='probe')return finish(null,row.port);}catch{}}};
  const timer=setTimeout(()=>finish(new Error('control-deadline')),ms);
  stream.on('data',receive);child.once('error',failed);child.once('exit',closed);
 });
}
export function inspectorRpc(ws,id,method,ms=5000) {
 return new Promise((resolve,reject)=>{
  const finish=(error,value)=>{clearTimeout(timer);for(const [type,handler] of listeners)ws.removeEventListener(type,handler);error?reject(error):resolve(value);};
  const receive=event=>{try{const raw=String(event.data);if(Buffer.byteLength(raw)>65536)throw new Error('inspector-message-limit');const value=JSON.parse(raw);if(value.id===id)finish(null,value);}catch(error){finish(error);}};
  const closed=()=>finish(new Error('inspector-closed')),failed=()=>finish(new Error('inspector-error'));
  const listeners=[['message',receive],['close',closed],['error',failed]];
  const timer=setTimeout(()=>finish(new Error('inspector-deadline')),ms);
  for(const [type,handler] of listeners)ws.addEventListener(type,handler);
  try{ws.send(JSON.stringify({id,method}));}catch(error){finish(error);}
 });
}

