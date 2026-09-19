/* The companion owns native files and processes. This adapter only transports
   bytes; reconnecting never resubmits commands or pending terminal input. */
'use strict';
(function(){
  function create(){
    const listeners=new Map(),encoder=new TextEncoder(),decoder=new TextDecoder();
    let stream=null,connected=false,started=false,closed=false,info=null,input=Promise.resolve(),inputEpoch=0,initialFailureReported=false;
    const key='mfem-local-controller';let client;
    try{
      // Duplicating a tab copies sessionStorage. Only a true reload may reuse
      // the controller identity; a copied tab must acquire its own lease.
      if(performance.getEntriesByType('navigation')[0]?.type==='reload')client=sessionStorage.getItem(key);
      if(!client)client=crypto.randomUUID();sessionStorage.setItem(key,client);
    }catch{client=crypto.randomUUID()}
    const emit=(name,value)=>{for(const callback of listeners.get(name)||[])callback(value)};
    const message=value=>emit('serial1-output-bytes',encoder.encode(JSON.stringify(value)+'\n'));
    async function request(path,options={}){
      const response=await fetch(path,{...options,credentials:'same-origin',cache:'no-store',headers:{'X-Workbench-Request':'1','X-Workbench-Client':client,...options.headers}});
      if(!response.ok){
        let detail;try{const result=await response.json();detail=result.error}catch{}
        const error=new Error(detail||'Local connection failed (HTTP '+response.status+').');error.status=response.status;throw error;
      }
      return response;
    }
    const post=(path,value)=>request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
    function connect(){
      if(closed)return;
      stream?.close();stream=new EventSource('/api/events?client='+encodeURIComponent(client)+'&after=0');
      stream.onopen=()=>{
        connected=true;emit('runtime-connected',info);
        if(!started){started=true;message({event:'ready'})}
      };
      stream.onmessage=event=>{
        try{
          const data=JSON.parse(event.data);
          if(data.channel===0){const raw=atob(data.bytes);emit('serial0-output-bytes',Uint8Array.from(raw,c=>c.charCodeAt(0)))}
          else if(data.channel===1){if(data.message?.event!=='ready')message(data.message)}
          else if(data.event==='gap')emit('runtime-warning',new Error('Some output was no longer available when the terminal reconnected. Native jobs were not restarted.'));
        }catch(error){emit('runtime-warning',new Error('Could not read local output: '+error.message))}
      };
      stream.addEventListener('gap',()=>emit('runtime-warning',new Error('The local output buffer wrapped while disconnected. Native jobs were not restarted.')));
      stream.onerror=()=>{
        if(connected){connected=false;inputEpoch++;emit('runtime-disconnected',new Error('Local connection interrupted. Reconnecting; native jobs remain with the companion.'))}
        else if(!started&&!initialFailureReported){initialFailureReported=true;emit('runtime-error',new Error('Could not open the local terminal connection. Reconnecting; keep the companion running, or reload using its pairing link.'))}
      };
    }
    const ready=(async()=>{
      if(window.WorkbenchLocalConfig?.protocol!==1)throw new Error('This companion and browser interface have incompatible versions. Update them together.');
      const fragment=new URLSearchParams(location.hash.slice(1)),token=fragment.get('pair');
      if(token){
        // Fragments are never sent in HTTP requests or referrers.
        history.replaceState(null,'',location.pathname+location.search);
        // Reopening the original printed URL in an already paired browser is
        // a reconnect, not an attempt to consume its one-use token again.
        try{info=await(await request('/api/session')).json()}
        catch(error){if(error.status!==401)throw error;await post('/api/pair',{token})}
      }
      info??=await(await request('/api/session')).json();
      if(info.protocol!==1)throw new Error('Unsupported local compute protocol. Update the companion and interface together.');
      connect();return info;
    })();
    function sendInput(bytes){
      if(!connected)return Promise.resolve(emit('runtime-warning',new Error('Input was not sent while disconnected. Reconnect before entering a command.')));
      const epoch=inputEpoch;
      const next=input.then(()=>{
        if(epoch!==inputEpoch||!connected)return;
        return request('/api/input',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:bytes});
      });
      // Report an uncertain delivery once; never retry a shell command.
      input=next.catch(error=>{inputEpoch++;emit('runtime-warning',new Error(error.message+' Input was not retried; queued input was cancelled. Check the terminal before resending.'))});
      return input;
    }
    const api={mode:'local',ready,get info(){return info},get connected(){return connected},
      add_listener(name,callback){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(callback)},
      remove_listener(name,callback){listeners.get(name)?.delete(callback)},
      serial0_send(text){return sendInput(encoder.encode(text))},
      serial_send_bytes(port,bytes){
        if(port===0)return sendInput(bytes);
        if(port!==1)return;
        for(const line of decoder.decode(bytes).split('\n').filter(Boolean)){
          const value=JSON.parse(line);
          if(!connected){message({id:value.id,error:'Local connection is interrupted. Reconnect before trying again.'});continue}
          post('/api/rpc',value).catch(error=>message({id:value.id,error:error.message}));
        }
      },
      async read_file(path){return new Uint8Array(await(await request('/api/file?path='+encodeURIComponent('/'+path.replace(/^\//,'')))).arrayBuffer())},
      async read_blob(path){return (await request('/api/file?path='+encodeURIComponent('/'+path.replace(/^\//,'')))).blob()},
      async create_file(path,bytes){await request('/api/file?path='+encodeURIComponent('/'+path.replace(/^\//,'')),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:bytes})},
      getWorkspaceWrites:async()=>({paths:[],writes:[],sequence:0,busy:false}),
      ackWorkspaceWrites:async()=>({paths:[],writes:[],sequence:0,busy:false}),
      finishDownloads(){},
      reconnect(){closed=false;connect()},
      destroy(){closed=true;connected=false;stream?.close()},
    };
    ready.catch(error=>emit('runtime-error',error));
    return api;
  }
  window.WorkbenchLocalRuntime={create};
})();
