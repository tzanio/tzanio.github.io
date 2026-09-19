/* Native files persist on disk. Only unsaved editor drafts live in IndexedDB. */
'use strict';
(function(){
  const DATABASE='mfem-native-editor-drafts-v1',MAX_BYTES=32*1024*1024,encoder=new TextEncoder();
  const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
  const path=value=>typeof value==='string'&&value.startsWith('/root/mfem/')&&value.length<=4096&&!/[\x00-\x1f\x7f]/.test(value)&&value.split('/').slice(1).every(part=>part&&part!=='.'&&part!=='..');
  const retained=buffer=>buffer.dirty||buffer.isNew||buffer.conflict?.deleted;
  function openDatabase(){return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DATABASE,1);
    req.onupgradeneeded=()=>req.result.createObjectStore('drafts',{keyPath:'workspaceId'});
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('Close older local-compute tabs, then retry saving drafts.'));
  })}
  async function transaction(db,mode,fn){
    const tx=db.transaction('drafts',mode),done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new Error('Draft storage was cancelled'));tx.onerror=()=>{}});
    let result;try{result=await fn(tx.objectStore('drafts'))}catch(error){try{tx.abort()}catch{}await done.catch(()=>{});throw error}
    await done;return result;
  }
  function mount({editor,runtime,onStatus=()=>{},notice=()=>{}}){
    let db,workspaceId,started=false,restoring=false,draftPending=false,writePending=false,timer,sequence=0,lastSaved=null,chain=Promise.resolve(),startPromise,destroyed=false,restoreFailed=false;
    const abort=new AbortController();
    const button=document.createElement('button');button.id='local-workspace-open';button.type='button';button.textContent='Local files';button.dataset.state='starting';
    document.querySelector('header nav').append(button);
    const panel=document.createElement('section');panel.id='local-workspace-window';
    panel.innerHTML='<p class="local-workspace-path"></p><p>Saved files are stored directly in your local checkout. Unsaved editor drafts are recovered separately in this browser.</p><p class="local-workspace-state" role="status"></p><p class="local-workspace-error" role="alert" hidden></p><button type="button" class="local-workspace-retry">Retry saving drafts</button>';
    const floating=WorkbenchWindows.attach(panel,{title:'Local files',width:470,anchor:button});
    const $=selector=>panel.querySelector(selector);
    button.onclick=()=>floating.toggle();
    let lastStatus='';
    function status(state,label,detail=''){
      const signature=JSON.stringify([state,label,detail]);if(signature===lastStatus)return;lastStatus=signature;
      button.dataset.state=state;button.title=label+(detail?' · '+detail:'');button.setAttribute('aria-label',button.textContent+': '+button.title);
      $('.local-workspace-state').textContent=label;$('.local-workspace-error').textContent=detail;$('.local-workspace-error').hidden=!detail;
      onStatus({state,label,detail,workspace:runtime.info?.workspace});
    }
    function fail(error){
      draftPending=true;
      const message=error?.name==='QuotaExceededError'?'Browser storage is full. Your local files are safe, but unsaved editor drafts have not been saved. Export them or free browser storage, then retry.':error?.message||String(error);
      status('error','Editor drafts not saved',message);notice(message);return message;
    }
    function validate(saved){
      if(!saved||saved.version!==1||saved.workspaceId!==workspaceId||!Array.isArray(saved.buffers)||saved.buffers.length>200)throw new Error('Saved editor drafts could not be read. They have not been overwritten.');
      const seen=new Set();
      for(const buffer of saved.buffers){
        if(!buffer||!path(buffer.path)||seen.has(buffer.path)||typeof buffer.text!=='string'||typeof buffer.baseText!=='string')throw new Error('Saved editor drafts are invalid. They have not been overwritten.');
        seen.add(buffer.path);
      }
      if(encoder.encode(JSON.stringify(saved)).length>MAX_BYTES)throw new Error('Editor drafts exceed the 32 MiB storage limit. Save some files, then retry.');
      return saved;
    }
    function snapshot(){
      return validate({version:1,workspaceId,buffers:[...editor.buffers.values()].filter(retained).map(buffer=>({path:buffer.path,text:buffer.doc.getValue(),baseText:buffer.baseText||'',revision:buffer.revision??null,isNew:!!buffer.isNew}))});
    }
    function captureDrafts({immediate=false}={}){
      if(!started||restoring||destroyed||restoreFailed)return Promise.resolve();
      clearTimeout(timer);timer=null;draftPending=true;const current=++sequence;
      if(!writePending)status('dirty','Editor drafts waiting to save…');
      const write=()=>{
        const operation=chain.catch(()=>{}).then(async()=>{
          writePending=true;
          try{
            const saved=snapshot(),serialized=JSON.stringify(saved);
            if(serialized!==lastSaved){
              status('saving','Saving editor drafts…');
              if(!db)db=await openDatabase();
              await transaction(db,'readwrite',store=>request(store.put({...saved,updated:Date.now()})));
              lastSaved=serialized;
            }
            if(current===sequence){draftPending=false;status('saved',saved.buffers.length?'Editor drafts saved in this browser':'Files saved on this computer');}
          }catch(error){fail(error);throw error}finally{writePending=false}
        });
        chain=operation;return operation;
      };
      if(immediate)return write();
      timer=setTimeout(()=>{timer=null;write().catch(()=>{})},350);return Promise.resolve();
    }
    function start(){
      if(startPromise)return startPromise;
      startPromise=(async()=>{
        restoring=true;restoreFailed=true;
        try{
          await runtime.ready;
          const info=runtime.info||{};
          if(typeof info.workspaceId!=='string'||!info.workspaceId)throw new Error('The companion did not identify this checkout; editor draft saving is unavailable.');
          workspaceId=info.workspaceId;button.textContent=/darwin|mac/i.test(info.platform||'')?'Files on this Mac':'Local files';$('.local-workspace-path').textContent=info.workspace||'';
          if(!db)db=await openDatabase();
          const saved=await transaction(db,'readonly',store=>request(store.get(workspaceId)));
          if(saved){
            validate(saved);
            // Include already-open tabs. restoreSession protects any text typed
            // during startup and gives colliding recovered drafts their own tab.
            const current=editor.exportSession(),tabs=new Map(current.tabs.map(tab=>[tab.path,tab]));
            for(const draft of saved.buffers)tabs.set(draft.path,{path:draft.path,draft:{text:draft.text,baseText:draft.baseText,isNew:draft.isNew}});
            const warnings=await editor.restoreSession({version:1,activePath:current.activePath,tabs:[...tabs.values()]},{preserveDirty:true});
            for(const warning of warnings||[])notice(warning);
          }
          restoreFailed=false;started=true;restoring=false;
          await captureDrafts({immediate:true});return true;
        }catch(error){started=true;restoring=false;fail(error);return false}
        finally{startPromise=null}
      })();return startPromise;
    }
    $('.local-workspace-retry').onclick=()=>{if(restoreFailed)start();else captureDrafts({immediate:true}).catch(()=>{})};
    document.addEventListener('visibilitychange',()=>{if(document.hidden)captureDrafts({immediate:true}).catch(()=>{})},{signal:abort.signal});
    window.addEventListener('pagehide',()=>{captureDrafts({immediate:true}).catch(()=>{})},{signal:abort.signal});
    status('starting','Opening editor draft storage…');
    return {start,captureDrafts,markPending:()=>{captureDrafts().catch(()=>{})},hasPendingChanges:()=>restoring||draftPending||writePending||(!started&&[...editor.buffers.values()].some(retained)),
      // Host files already persist. Archive coordination must leave draft writes
      // enabled and has no emulated filesystem checkpoint to drain.
      suspendFilesystem:()=>Promise.resolve(),resumeFilesystem:()=>{},
      get ready(){return started&&!restoring},get current(){return {id:workspaceId,name:runtime.info?.workspace||'Local files'}},get database(){return db},open:()=>floating.open(),
      destroy(){destroyed=true;clearTimeout(timer);abort.abort();floating.destroy();button.remove();chain.finally(()=>db?.close()).catch(()=>{})}};
  }
  window.WorkbenchLocalWorkspace={mount,databaseName:DATABASE};
})();
