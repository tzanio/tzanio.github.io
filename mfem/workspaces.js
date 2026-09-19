/* Named browser-local workspaces. A manifest is committed only after all of
 * its content blobs exist; the previous complete checkpoint remains available.
 * Editor drafts are independent from files written by Linux. */
'use strict';
(function(){
  const DATABASE='mfem-browser-workspaces-v1',ROOT='/root/mfem/';
  const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
  function openDatabase(){return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DATABASE,1);
    req.onupgradeneeded=()=>{const db=req.result;for(const [name,keyPath] of [['workspaces','id'],['blobs','hash'],['drafts','id'],['settings','key']])db.createObjectStore(name,{keyPath})};
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('Another tab is blocking workspace storage. Close it and retry.'));
  })}
  async function transact(db,names,mode,fn){
    const tx=db.transaction(names,mode);
    const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new Error('Workspace storage transaction was cancelled'));tx.onerror=()=>{}});
    let result;
    try{result=await fn(tx)}catch(error){try{tx.abort()}catch{}await done.catch(()=>{});throw error}
    await done;return result;
  }
  const read=(db,store,key)=>transact(db,[store],'readonly',tx=>request(tx.objectStore(store).get(key)));
  const all=(db,store)=>transact(db,[store],'readonly',tx=>request(tx.objectStore(store).getAll()));
  const put=(db,store,value)=>transact(db,[store],'readwrite',tx=>request(tx.objectStore(store).put(value)));
  const id=()=>crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
  const time=value=>new Date(value).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  const size=value=>(value/1048576).toFixed(1)+' MiB';
  function mount({rpc,readFile,upload,editor,journal,baseRelease,onRestore=async()=>{},onStatus=()=>{},reload=()=>location.reload()}){
    let db,record,base,started=false,restoring=true,busy=null,draftTimer,saveTimer,pollTimer,lastSequence=-1,startChoice,draftPending=false,draftSequence=0,filesystemPending=true;
    let owner=id(),lastStatus='',listSignature='',renderedWorkspaceId,renderedWorkspaceName;
    let filesystemSuspended=false,filesystemDeferred=false;
    try{
      // Keep ownership across an ordinary reload even if the old page's last
      // lease-release transaction was interrupted by navigation.
      if(performance.getEntriesByType('navigation')[0]?.type==='reload')owner=sessionStorage.getItem('mfem-workspace-tab-owner')||owner;
      sessionStorage.setItem('mfem-workspace-tab-owner',owner);
    }catch{}
    const button=document.createElement('button');button.id='workspace-open';button.type='button';button.dataset.state='starting';
    const buttonLabel=document.createElement('span');buttonLabel.className='workspace-label';buttonLabel.textContent='Workspace';button.append(buttonLabel);
    button.title='Workspace files and drafts are saved in this browser on this device.';
    document.querySelector('header nav').append(button);
    const panel=document.createElement('section');panel.id='workspace-window';
    panel.innerHTML='<p class="workspace-scope">Saved in this browser on this device. Export a backup to move your work elsewhere.</p><p class="workspace-state" role="status">Opening local storage…</p><progress hidden></progress><div class="workspace-controls"><label>Workspace<select aria-label="Saved workspace"></select></label><label>Name<input class="workspace-name" maxlength="80" placeholder="Workspace name"></label><div class="workspace-actions"><button data-action="rename">Rename</button><button data-action="new">New workspace</button></div><label class="workspace-builds"><input type="checkbox" checked>Keep changed build outputs</label><p class="workspace-storage"></p><div class="workspace-actions"><button data-action="save">Save now</button><button data-action="previous">Recover previous checkpoint</button><button data-action="backup">Download saved checkpoint</button><button data-action="retry">Retry</button><button data-action="fresh" hidden>Start a new workspace</button><button data-action="temporary" hidden>Continue temporarily</button></div><p class="workspace-error" hidden></p><p class="workspace-draft-note">Unsaved editor drafts are recovered separately. Terminal changes, Git state, deleted files and renamed files are included in checkpoints.</p></div>';
    document.body.append(panel);
    const maintenance=document.createElement('div');maintenance.className='workspace-actions';maintenance.innerHTML='<button data-action="free-builds">Remove saved build cache</button><button data-action="free-previous">Remove previous checkpoint</button>';panel.querySelector('.workspace-controls').append(maintenance);
    const pauseNotice=document.createElement('p');pauseNotice.className='workspace-pause';pauseNotice.hidden=true;pauseNotice.setAttribute('role','status');pauseNotice.textContent='Wait for workspace import or export to finish before changing saved workspaces.';panel.prepend(pauseNotice);
    const pausedControls=new Map();
    function applySuspendedControls(){
      if(!filesystemSuspended)return;
      for(const control of panel.querySelectorAll('button,input,select')){
        if(control.classList.contains('wb-window-close'))continue;
        if(!pausedControls.has(control))pausedControls.set(control,control.disabled);
        control.disabled=true;
      }
    }
    function requireFilesystem(){if(filesystemSuspended)throw new Error(pauseNotice.textContent)}
    const floating=WorkbenchWindows.attach(panel,{title:'Workspaces',width:470,anchor:button});
    const $=selector=>panel.querySelector(selector),action=name=>$('[data-action="'+name+'"]');
    button.onclick=()=>{floating.toggle();refreshList().catch(fail)};
    function status(state,label,detail=''){
      const name=record?.name||'Workspace',signature=JSON.stringify([state,label,detail,name]);
      if(signature===lastStatus)return;lastStatus=signature;
      // Saving state must not resize the navigation row every time a checkpoint
      // runs. Keep its label stable; expose details in the dialog and tooltip.
      if(button.dataset.state!==state)button.dataset.state=state;
      if(buttonLabel.textContent!==name)buttonLabel.textContent=name;
      button.title=name+' · '+label+(detail?' · '+detail:'');
      button.setAttribute('aria-label',name+' workspace: '+label+(detail?'. '+detail:''));
      $('.workspace-state').textContent=label;$('.workspace-error').hidden=!detail;
      $('.workspace-error').textContent=detail;onStatus({state,label,detail,workspace:record?.name});
    }
    function fail(error){
      let message=error?.message||String(error);
      if(error?.name==='QuotaExceededError')message='Browser storage is full. Turn off “Keep changed build outputs”, then retry. Your previous saved checkpoint is intact; you can download it here.';
      status('error','Not saved',message);$('progress').hidden=true;
      return message;
    }
    async function refreshList(){
      if(!db)return;
      const choices=(await all(db,'workspaces')).sort((a,b)=>a.name.localeCompare(b.name)),select=$('select');
      const signature=JSON.stringify(choices.map(item=>[item.id,item.name,item.base_id]));
      if(signature!==listSignature){
        listSignature=signature;select.replaceChildren();
        for(const item of choices){const option=document.createElement('option');option.value=item.id;option.textContent=item.name+(item.base_id!==base?.base_id?' (different base)':'');select.append(option)}
      }
      if(record){
        select.value=record.id;
        const name=$('.workspace-name');
        // Retain an unsubmitted name even after focus moves to Save now or
        // another control. Only a real name/workspace change replaces it.
        if(record.id!==renderedWorkspaceId||record.name!==renderedWorkspaceName||name.value===renderedWorkspaceName)name.value=record.name;
        renderedWorkspaceId=record.id;renderedWorkspaceName=record.name;
        $('.workspace-builds input').checked=record.keepBuilds!==false;
      }
      action('previous').disabled=!record?.previous;action('backup').disabled=!record?.current;
      const estimate=await navigator.storage?.estimate?.().catch(()=>({}))||{};
      $('.workspace-storage').textContent=estimate.quota?size(estimate.usage||0)+' used · '+size(Math.max(0,estimate.quota-(estimate.usage||0)))+' browser storage available':'';
      applySuspendedControls();
    }
    async function claim(item){
      return transact(db,['workspaces'],'readwrite',async tx=>{
        const store=tx.objectStore('workspaces'),latest=await request(store.get(item.id));
        if(latest?.owner&&latest.owner!==owner&&latest.leaseUntil>Date.now())throw new Error('This workspace is open in another tab. Close that tab, retry, or start a new workspace.');
        const claimed={...item,...latest,owner,leaseUntil:Date.now()+30000};await request(store.put(claimed));return claimed;
      });
    }
    async function updateRecord(change){
      return transact(db,['workspaces'],'readwrite',async tx=>{
        const store=tx.objectStore('workspaces'),latest=await request(store.get(record.id));
        if(latest?.owner!==owner)throw new Error('Another tab owns this workspace. Retry before changing its saved settings.');
        const updated=change(latest);await request(store.put(updated));return updated;
      });
    }
    async function create(name){
      requireFilesystem();
      const item={id:id(),name:(name||'Untitled').trim().slice(0,80)||'Untitled',base_id:base.base_id,base_commit:base.base_commit,keepBuilds:true,current:null,previous:null,created:Date.now(),owner,leaseUntil:Date.now()+30000};
      await put(db,'workspaces',item);requireFilesystem();return item;
    }
    async function uploadGeneration(generation){
      const files=[];
      try{
        const hashes=[...new Set(Object.values(generation.manifest.entries).filter(entry=>entry.kind==='file').map(entry=>entry.hash))];
        for(let index=0;index<hashes.length;index++){
          status('restoring','Restoring '+(index+1)+' / '+hashes.length+' files');
          const blob=await read(db,'blobs',hashes[index]);if(!blob)throw new Error('This checkpoint is missing a saved file. Try the previous checkpoint.');
          const bytes=new Uint8Array(await blob.data.arrayBuffer());if(await digest(bytes)!==blob.hash)throw new Error('A saved file failed its checksum. Try the previous checkpoint.');
          files.push({hash:blob.hash,upload:await upload(bytes)});
        }
        await rpc('workspace-restore',{manifest:generation.manifest,files});
      }finally{for(const file of files)rpc('unlink',{path:file.upload}).catch(()=>{})}
    }
    async function restoreDrafts(){
      const saved=await read(db,'drafts',record.id);
      for(const draft of saved?.buffers||[]){
        let buffer;
        try{buffer=await editor.open(draft.path,undefined,undefined,{focus:false})}
        catch(error){if(!/No such file|not found|ENOENT/i.test(error.message))throw error;buffer=await editor.newFile(draft.path,{text:'',focus:false})}
        if(draft.baseText!==undefined){buffer.baseText=draft.baseText;buffer.revision=draft.revision}
        buffer.doc.setValue(draft.text);buffer.dirty=buffer.isNew||draft.text!==buffer.baseText;
      }
      await editor.checkExternal();
    }
    async function start(){
      try{
        db=await openDatabase();base=await rpc('workspace-init');
        const setting=await read(db,'settings','active');record=setting?await read(db,'workspaces',setting.value):null;
        if(!record){record=await create('Default');await put(db,'settings',{key:'active',value:record.id})}
        await refreshList();
        if(record.base_id!==base.base_id)throw new Error('This saved workspace uses a different MFEM base image. Download its checkpoint before migrating, or start a new workspace. It has not been overwritten.');
        record=await claim(record);
        status('restoring','Restoring workspace');
        if(record.current)await uploadGeneration(record.current);
        await onRestore();await restoreDrafts();
        // Startup restores a generation that is already durable, with normal
        // editor/terminal writes still gated by the application.
        if(journal)await journal.ackWorkspaceWrites((await journal.getWorkspaceWrites()).sequence);
        restoring=false;started=true;
        await rpc('workspace-ready');
        status('saved',record.current?'Saved · '+time(record.current.created):'Ready to save');
        pollTimer=setInterval(poll,5000);scheduleSave(1000);return true;
      }catch(error){
        fail(error);floating.open({focus:false});action('fresh').hidden=false;action('temporary').hidden=false;
        // A checkpoint or a quota failure never silently replaces an existing
        // workspace. The user can retry, recover, download, or use a new one.
        return new Promise(resolve=>{startChoice=resolve});
      }
    }
    async function captureDrafts({immediate=false}={}){
      if(!db||!record||restoring||!started)return;
      clearTimeout(draftTimer);
      draftPending=true;const sequence=++draftSequence;
      const write=async()=>{
        const buffers=[...editor.buffers.values()].filter(buffer=>buffer.dirty||buffer.isNew||buffer.conflict?.deleted).map(buffer=>({path:buffer.path,text:buffer.doc.getValue(),baseText:buffer.baseText,revision:buffer.revision,isNew:buffer.isNew}));
        await transact(db,['workspaces','drafts'],'readwrite',async tx=>{
          const current=await request(tx.objectStore('workspaces').get(record.id));
          if(current.owner!==owner)throw new Error('Another tab owns this workspace. Open a new workspace to keep these drafts.');
          await request(tx.objectStore('drafts').put({id:record.id,buffers,updated:Date.now()}));
        });if(sequence===draftSequence)draftPending=false;
      };
      if(immediate)return write();
      draftTimer=setTimeout(()=>write().catch(fail),350);
    }
    function scheduleSave(delay=2000){
      if(!started||restoring)return;
      if(filesystemSuspended){filesystemDeferred=true;return}
      if(saveTimer)return;saveTimer=setTimeout(()=>{saveTimer=null;checkpoint().catch(()=>{})},delay);
    }
    function suspendFilesystem(){
      filesystemSuspended=true;
      pauseNotice.hidden=false;applySuspendedControls();
      if(saveTimer){clearTimeout(saveTimer);saveTimer=null;filesystemDeferred=true}
      // Complete an existing transaction before an archive changes/reads files.
      // A failed autosave must still allow exporting a rescue copy of the work.
      return Promise.resolve(busy).catch(()=>{});
    }
    function resumeFilesystem(){
      if(!filesystemSuspended)return;
      filesystemSuspended=false;
      pauseNotice.hidden=true;
      for(const [control,disabled] of pausedControls)control.disabled=disabled;
      pausedControls.clear();refreshList().catch(fail);
      const pending=filesystemDeferred||filesystemPending;
      filesystemDeferred=false;if(pending)scheduleSave();
    }
    function handleGuestEvent(message){
      if(message.event!=='workspace-dirty'||!started||restoring)return;
      lastSequence=message.sequence;filesystemPending=true;if(!busy)status('dirty','Saving soon');scheduleSave(4500);
    }
    function markPending(){if(!started||restoring)return;filesystemPending=true;if(!busy)status('dirty','Checking changes');scheduleSave(4500)}
    journal?.add_listener('workspace-write',markPending);
    async function poll(){
      if(!started||restoring)return;
      try{
        record=await claim(record);
        // Keep the lease alive during a long archive, without guest filesystem
        // RPCs competing with it. Recheck guest state when the archive finishes.
        if(filesystemSuspended){filesystemDeferred=true;return}
        const state=await rpc('workspace-status');
        if(state.dirty||state.sequence!==lastSequence){lastSequence=state.sequence;scheduleSave()}
      }catch(error){fail(error)}
    }
    function filteredManifest(manifest){
      if(record.keepBuilds!==false)return manifest;
      const skip=name=>base.build_paths?.includes(name)||name==='.mfem-build'||name.startsWith('.mfem-build/')||/\.(o|a|gch|d)$/.test(name);
      return {...manifest,entries:Object.fromEntries(Object.entries(manifest.entries).filter(([name,entry])=>!entry.build&&!skip(name)&&!(entry.kind==='hardlink'&&(skip(entry.target)||manifest.entries[entry.target]?.build)))),deleted:manifest.deleted.filter(name=>!skip(name)),build_outputs_omitted:true};
    }
    async function checkpoint({force=false,attempt=0}={}){
      if(filesystemSuspended){filesystemDeferred=true;return null}
      if(busy){let result;try{result=await busy}catch(error){if(!force)throw error}if(force)return checkpoint({force:true});return result}if(!started||restoring||!db)return;
      busy=(async()=>{
        let response,writes;
        const added=[];
        try{
          record=await claim(record);
          await captureDrafts({immediate:true});
          writes=await journal?.getWorkspaceWrites();
          // A change notification during the previous save can leave a queued
          // timer behind. Renew the lease and verify both monitors before
          // skipping it, without flashing a spurious Saving state.
          if(!force&&record.current&&!filesystemPending&&!writes?.paths.length&&!writes?.busy){
            const state=await rpc('workspace-status');
            if(!state.dirty&&state.sequence===lastSequence)return record.current;
          }
          if(writes?.busy){status('dirty','Waiting to save','Waiting for file writes to finish');scheduleSave(2000);return null}
          status('saving','Saving');
          const keys=await transact(db,['blobs'],'readonly',tx=>request(tx.objectStore('blobs').getAllKeys()));
          response=await rpc('workspace-checkpoint',{known:keys,defer_busy:!force,written_paths:writes?.paths||[]},event=>{
            const meter=$('progress');meter.hidden=false;if(event.total>0){meter.max=event.total;meter.value=event.completed}else meter.removeAttribute('value');
          });
          if(response.deferred){status('dirty','Waiting to save',response.deferred);scheduleSave(5000);return null}
          const manifest=filteredManifest(response.manifest),needed=new Set(Object.values(manifest.entries).filter(entry=>entry.kind==='file').map(entry=>entry.hash));
          for(const file of response.files){
            try{
              if(!needed.has(file.hash))continue;
              const bytes=await readFile(file.path);if(await digest(bytes)!==file.hash)throw new Error('A workspace transfer failed its checksum; retry saving.');
              // Blobs can be written independently: no generation points at
              // them until the final atomic manifest transaction below.
              await put(db,'blobs',{hash:file.hash,data:new Blob([bytes]),size:bytes.length,created:Date.now()});added.push(file.hash);
            }finally{rpc('unlink',{path:file.path}).catch(()=>{})}
          }
          const after=await journal?.getWorkspaceWrites();
          if(after&&(after.busy||after.writes.some(item=>item.sequence>writes.sequence))){
            filesystemPending=true;status('dirty','Saving soon','Files changed while saving; retrying');scheduleSave(2000);return null;
          }
          const signature=JSON.stringify({entries:manifest.entries,deleted:manifest.deleted,build_outputs_omitted:manifest.build_outputs_omitted});
          record=await transact(db,['workspaces','blobs'],'readwrite',async tx=>{
            const store=tx.objectStore('workspaces'),current=await request(store.get(record.id));
            if(current.owner!==owner)throw new Error('Another tab owns this workspace. Your previous checkpoint is intact.');
            for(const hash of needed)if(!await request(tx.objectStore('blobs').getKey(hash)))throw new Error('A checkpoint file is missing; retry saving.');
            const generation={id:id(),created:Date.now(),manifest,signature};
            const next={...current,keepBuilds:record.keepBuilds,leaseUntil:Date.now()+30000,
              previous:current.current?.signature===signature?current.previous:current.current,
              current:current.current?.signature===signature?{...current.current,manifest}:generation};
            await request(store.put(next));return next;
          });
          const remaining=writes?await journal.ackWorkspaceWrites(writes.sequence):null;
          const state=await rpc('workspace-ack',{sequence:manifest.sequence});lastSequence=manifest.sequence;filesystemPending=state.dirty;
          if(remaining?.paths.length){state.dirty=true;filesystemPending=true}
          status(state.dirty?'dirty':'saved',state.dirty?'Saving soon':'Saved · '+time(record.current.created));
          $('progress').hidden=true;await refreshList();if(state.dirty)scheduleSave();return record.current;
        }catch(error){fail(error);throw error}
        finally{
          if(response)for(const file of response.files||[])rpc('unlink',{path:file.path}).catch(()=>{});
          busy=null;
        }
      })();const result=await busy;
      if(filesystemSuspended){filesystemDeferred=true;return result}
      if(force&&!result){
        if(attempt>=2){const error=new Error('Files are still changing. Wait for the command to finish, then save again.');fail(error);throw error}
        await new Promise(resolve=>setTimeout(resolve,500));return checkpoint({force:true,attempt:attempt+1});
      }
      return result;
    }
    async function release(){if(!db||!record)return;await transact(db,['workspaces'],'readwrite',async tx=>{const store=tx.objectStore('workspaces'),latest=await request(store.get(record.id));if(latest?.owner===owner)await request(store.put({...latest,owner:null,leaseUntil:0}))})}
    async function switchWorkspace(next){
      requireFilesystem();
      if(started){await checkpoint({force:true});await captureDrafts({immediate:true})}
      requireFilesystem();
      await release();
      requireFilesystem();
      await put(db,'settings',{key:'active',value:next.id});reload();
    }
    async function previous(){
      requireFilesystem();
      if(!record?.previous)return;
      if(busy)await busy.catch(()=>{});
      requireFilesystem();
      await captureDrafts({immediate:true});
      requireFilesystem();
      restoring=true;clearTimeout(saveTimer);saveTimer=null;
      try{
        record=await updateRecord(latest=>{
          requireFilesystem();
          if(!latest.previous)throw new Error('There is no previous checkpoint to recover.');
          return {...latest,current:latest.previous,previous:latest.current,owner:null,leaseUntil:0};
        });reload();
      }catch(error){restoring=false;scheduleSave();throw error}
    }
    // Portable saved-layer tar, including content blobs. It can be downloaded
    // even if this deployment's MFEM base is incompatible with the checkpoint.
    async function downloadCheckpoint(){
      if(!record?.current)return;
      const activity=WorkbenchOperations.start('Saved workspace checkpoint',{label:'Reading saved files…'});
      try{
      const files=[{name:'.mfem-checkpoint.json',data:new Blob([JSON.stringify(record.current.manifest)])}];
      const hashes=new Set(Object.values(record.current.manifest.entries).filter(entry=>entry.kind==='file').map(entry=>entry.hash));
      for(const hash of hashes){const item=await read(db,'blobs',hash);if(!item)throw new Error('The saved checkpoint is missing a file. Try the previous checkpoint.');files.push({name:'blobs/'+hash,data:item.data});activity.update({stage:'reading',label:'Reading saved files…',completed:files.length-1,total:hashes.size,unit:'files'})}
      const chunks=[];
      for(const file of files){
        const header=new Uint8Array(512),write=(offset,value)=>header.set(new TextEncoder().encode(value),offset);
        write(0,file.name);write(100,'0000600\0');write(108,'0000000\0');write(116,'0000000\0');write(124,file.data.size.toString(8).padStart(11,'0')+'\0');write(136,Math.floor(Date.now()/1000).toString(8).padStart(11,'0')+'\0');write(148,'        ');write(156,'0');write(257,'ustar\0');write(263,'00');write(148,header.reduce((sum,value)=>sum+value,0).toString(8).padStart(6,'0')+'\0 ');
        chunks.push(header,file.data);if(file.data.size%512)chunks.push(new Uint8Array(512-file.data.size%512));
      }
      chunks.push(new Uint8Array(1024));
      WorkbenchOperations.download(activity,new Blob(chunks,{type:'application/x-tar'}),record.name.replace(/[^a-z0-9_.-]/gi,'-')+'-checkpoint.tar',{type:'application/x-tar'});
      }catch(error){activity.fail(error,{retry:downloadCheckpoint});throw error}
    }
    async function freeStorage(kind){
      requireFilesystem();
      if(!db||!record)return;if(busy)await busy.catch(()=>{});
      requireFilesystem();
      record=await transact(db,['workspaces','blobs'],'readwrite',async tx=>{
        const store=tx.objectStore('workspaces'),latest=await request(store.get(record.id));
        requireFilesystem();
        if(latest.owner&&latest.owner!==owner&&latest.leaseUntil>Date.now())throw new Error('Close the other workspace tab before removing saved data.');
        if(kind==='previous')latest.previous=null;
        else{
          record.keepBuilds=false;latest.keepBuilds=false;
          for(const key of ['current','previous'])if(latest[key]){
            const manifest=filteredManifest(latest[key].manifest);
            latest[key]={...latest[key],manifest,signature:JSON.stringify({entries:manifest.entries,deleted:manifest.deleted,build_outputs_omitted:true})};
          }
        }
        await request(store.put(latest));
        const records=await request(store.getAll()),used=new Set();
        for(const item of records)for(const generation of [item.current,item.previous])if(generation)for(const entry of Object.values(generation.manifest.entries))if(entry.kind==='file')used.add(entry.hash);
        const blobs=tx.objectStore('blobs');for(const hash of await request(blobs.getAllKeys()))if(!used.has(hash))await request(blobs.delete(hash));
        return latest;
      });
      await refreshList();if(started)await checkpoint({force:true});
    }
    action('free-builds').onclick=()=>freeStorage('builds').catch(fail);
    action('free-previous').onclick=()=>freeStorage('previous').catch(fail);
    action('save').onclick=()=>checkpoint({force:true}).catch(()=>{});
    action('retry').onclick=async()=>{
      if(filesystemSuspended){fail(new Error(pauseNotice.textContent));return}
      if(started){await checkpoint({force:true}).catch(()=>{});return}
      const resolve=startChoice;startChoice=null;const result=await start();resolve?.(result);
    };
    action('backup').onclick=()=>downloadCheckpoint().catch(fail);
    action('previous').onclick=()=>previous().catch(fail);
    action('rename').onclick=async()=>{try{requireFilesystem();if(!record)return;const name=$('.workspace-name').value.trim().slice(0,80)||record.name;record=await updateRecord(latest=>{requireFilesystem();return {...latest,name}});const [,label,detail]=JSON.parse(lastStatus);status(button.dataset.state,label,detail);await refreshList()}catch(error){fail(error)}};
    action('new').onclick=async()=>{try{requireFilesystem();const name=$('.workspace-name').value.trim()||'Workspace';if(started)await checkpoint();requireFilesystem();await switchWorkspace(await create(name))}catch(error){fail(error)}};
    action('fresh').onclick=async()=>{try{requireFilesystem();if(!db)db=await openDatabase();if(!base)base=await rpc('workspace-init');requireFilesystem();const next=await create($('.workspace-name').value.trim()||'New workspace');await switchWorkspace(next)}catch(error){fail(error)}};
    action('temporary').onclick=async()=>{try{requireFilesystem();restoring=false;started=false;await rpc('workspace-ready');status('error','Temporary session','Files in this session require export; automatic workspace saving is unavailable.');floating.close();startChoice?.(false);startChoice=null}catch(error){fail(error)}};
    $('select').onchange=async event=>{try{requireFilesystem();const next=await read(db,'workspaces',event.target.value);requireFilesystem();if(next&&next.id!==record?.id)await switchWorkspace(next)}catch(error){fail(error)}};
    $('.workspace-builds input').onchange=async event=>{if(!record)return;const keepBuilds=event.target.checked;try{requireFilesystem();record=await updateRecord(latest=>{requireFilesystem();return {...latest,keepBuilds}});await checkpoint({force:true})}catch(error){fail(error)}};
    document.addEventListener('visibilitychange',()=>{if(document.hidden){captureDrafts({immediate:true}).catch(fail);if(started)checkpoint().catch(()=>{})}});
    window.addEventListener('pagehide',()=>release().catch(()=>{}));
    return {start,checkpoint,captureDrafts,suspendFilesystem,resumeFilesystem,handleGuestEvent,markPending,downloadCheckpoint,hasPendingChanges:()=>!started||restoring||!!busy||draftPending||filesystemPending,open:()=>{floating.open();refreshList().catch(fail)},get ready(){return started&&!restoring},get current(){return record},get database(){return db},destroy(){clearInterval(pollTimer);clearTimeout(saveTimer);clearTimeout(draftTimer);floating.destroy();button.remove();db?.close()}};
  }
  window.WorkbenchWorkspaces={mount,databaseName:DATABASE};
})();
