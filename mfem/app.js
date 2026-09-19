'use strict';
const $ = id => document.getElementById(id);
const asset = path => window.WorkbenchAssets?.[path] ? path + '?v=' + window.WorkbenchAssets[path] : path;
const encoder=new TextEncoder(),decoder=new TextDecoder(),serialDecoder=new TextDecoder();
const sourceRoot='/root/mfem',editorLimit=3*1024*1024;
const terminal=new Terminal({cursorBlink:true,fontSize:13,fontFamily:'Menlo, Consolas, monospace',theme:{background:'#0c1118',foreground:'#d0dbe7',cursor:'#a6e7be',black:'#17202b',red:'#f08080',green:'#a6e7be',yellow:'#e9cd87',blue:'#81b5f5',magenta:'#c49be8',cyan:'#83d5db',white:'#d0dbe7'},scrollback:5000});
$('terminal').replaceChildren();
terminal.open($('terminal'));
WorkbenchThemes.bindTerminal(terminal);
terminal.writeln('\x1b[38;5;114mStarting Linux\x1b[0m');
let ready=false,currentPath='',dirty=false,sequence=0,serialBuffer='',terminalCwd=sourceRoot+'/examples',workspaceBusy=false,restoringWorkspace=false;
let editor,simulation,layout,offline;
const waiting=new Map(),directories=new Map(),fileMetadata=new Map(),expanded=new Set();
const diagnostics={frames:0,updates:0,commands:0,filesIndexed:false,bootMs:null,filesOpenMs:null,firstRenderMs:null};
function notice(message) {
  $('notice').textContent=message;$('notice').hidden=false;
  clearTimeout(notice.timer);notice.timer=setTimeout(()=>$('notice').hidden=true,7000);
}
function systemStatus(state,label) {
  const indicator=$('status');indicator.dataset.state=state;
  indicator.title=label;indicator.setAttribute('aria-label',label);
}
const vm=WorkbenchRuntime.create({preload_files:['lib/ld-musl-i386.so.1','bin/bash','usr/lib/libpython3.12.so.1.0','usr/lib/libstdc++.so.6.0.33','usr/lib/libgcc_s.so.1','root/mfem/libmfem.so.4.10','root/mfem/examples/ex1','root/mfem/data/star.mesh'],disable_keyboard:true,disable_mouse:true,wasm_path:'vm/v86.wasm',memory_size:768*1024*1024,vga_memory_size:8*1024*1024,bios:{url:'vm/seabios.bin'},vga_bios:{url:'vm/vgabios.bin'},bzimage:{url:'vm/linux.bin'},initrd:{url:'vm/initrd.gz'},filesystem:{basefs:{url:'vm/fs.json'},baseurl:'vm/fs/'},cmdline:'console=ttyS0 quiet tsc=reliable mitigations=off random.trust_cpu=on init=/init mfem.autorun=ex1',autostart:true,uart1:true});
diagnostics.runtimeMode=vm.mode;
window.workstation={vm,terminal,diagnostics,get ready(){return ready},get editor(){return editor},get simulation(){return simulation},get layout(){return layout},get offline(){return offline},get viewer(){return simulation?.viewer},get controls(){return simulation?.controls},get streams(){return simulation?.streams},openFile,openDiagnostic,rpc};
Object.defineProperty(window,'viewer',{get:()=>simulation?.viewer});
vm.add_listener('serial0-output-bytes',bytes=>terminal.write(bytes));
vm.add_listener('runtime-error',error=>{
  ready=false;systemStatus('error','Alpine Linux stopped');window.WorkbenchStartup?.error(error.message);notice(error.message);
  for(const task of waiting.values()){clearTimeout(task.timer);task.reject(error)}waiting.clear();
});
vm.ready.catch(error=>notice(error.message));
terminal.onData(data=>vm.serial0_send(data));
terminal.parser.registerOscHandler(7,data=>{try{const url=new URL(data);if(url.protocol==='file:')terminalCwd=decodeURIComponent(url.pathname)}catch{}return true});
function rpc(op,values={},onProgress) {
  return new Promise((resolve,reject)=>{
    if(!ready){reject(new Error('Linux is still starting; you can save once it is ready.'));return}
    const id=++sequence;
    const task={resolve,reject,onProgress,timer:null};
    task.touch=()=>{clearTimeout(task.timer);task.timer=setTimeout(()=>{waiting.delete(id);reject(new Error(op+' timed out; check the terminal'))},180000)};
    task.touch();waiting.set(id,task);
    vm.serial_send_bytes(1,encoder.encode(JSON.stringify({id,op,...values})+'\n'));
  });
}
async function readGuest(path) {
  const snapshot=await rpc('read',{path,max_bytes:editorLimit,metadata:true});
  try{return snapshot.size===0?new Uint8Array(0):await vm.read_file(snapshot.path.slice(1))}
  finally{rpc('unlink',{path:snapshot.path}).catch(()=>{})}
}
async function upload(bytes) {
  const path='/tmp/studio-upload-'+Date.now()+'-'+(++sequence);
  await vm.create_file(path.slice(1),bytes);return path;
}
async function readEditorFile(path,{ifRevision}={}) {
  if(restoringWorkspace)throw new Error('Workspace import is in progress. Open the file again when it finishes.');
  let bytes,revision;
  if(ready) {
    const snapshot=await rpc('read',{path,max_bytes:editorLimit,metadata:true,if_revision:ifRevision});revision=snapshot.revision;
    if(snapshot.unchanged)return snapshot;
    try{bytes=snapshot.size===0?new Uint8Array(0):await vm.read_file(snapshot.path.slice(1))}
    finally{rpc('unlink',{path:snapshot.path}).catch(()=>{})}
  } else {
    await indexReady;
    const metadata=fileMetadata.get(path);
    if(!metadata?.blob)throw new Error('This file is available when Linux finishes starting.');
    if(metadata.encoding)throw new Error('Use the terminal for compiled binary files.');
    const response=await fetch('vm/fs/'+metadata.blob);if(!response.ok)throw new Error('Unable to load source');
    bytes=new Uint8Array(await response.arrayBuffer());
    revision=metadata.blob.replace(/\.bin$/,'');
  }
  if(bytes.length>editorLimit||bytes.subarray(0,4096).includes(0))throw new Error('Use the terminal for binary files or files larger than 3 MB.');
  return {text:decoder.decode(bytes),revision};
}
async function writeEditorFile(path,text,{expectedHash}={}) {
  if(restoringWorkspace)throw new Error('Wait for workspace import to finish before saving. Your changes remain in the editor.');
  if(!ready)throw new Error('Linux is still starting. Your changes remain in the editor.');
  const uploaded=await upload(encoder.encode(text));
  if(restoringWorkspace){rpc('unlink',{path:uploaded}).catch(()=>{});throw new Error('Wait for workspace import to finish before saving. Your changes remain in the editor.')}
  return rpc('write',{path,upload:uploaded,expected_hash:expectedHash});
}
function syncEditor(state) {
  currentPath=state.path||'';dirty=state.dirty;
  $('filename').textContent=currentPath?currentPath.replace('/root/','')+(state.activeDirty?' •':''):'Editor';
  $('save').disabled=!ready||!currentPath;
  document.querySelectorAll('#tree button').forEach(row=>row.classList.toggle('selected',row.title===currentPath));
}
editor=WorkbenchEditor.create($('editor-host'),{
  readFile:readEditorFile,writeFile:writeEditorFile,isReady:()=>ready,onNotice:notice,onChange:syncEditor,
  getDefaultDirectory:()=>currentPath?currentPath.slice(0,currentPath.lastIndexOf('/')):sourceRoot+'/examples',
  onSaved:({path,created})=>{if(created)revealCreatedFile(path).catch(error=>notice(error.message));},
});
simulation=SimulationWorkbench.create($('simulation'),{rpc,readFile:path=>vm.read_file(path.slice(1)),upload,notice,diagnostics,startupPreview:asset('startup-ex1.json')});
$('view-placeholder').querySelector('p').textContent='Starting ./ex1…';
vm.add_listener('serial1-output-bytes',bytes=>{
  serialBuffer+=serialDecoder.decode(bytes,{stream:true});
  let end;
  while((end=serialBuffer.indexOf('\n'))>=0) {
    const line=serialBuffer.slice(0,end);serialBuffer=serialBuffer.slice(end+1);
    try {
      const message=JSON.parse(line);
      if(message.event==='ready') {
        ready=true;diagnostics.bootMs=performance.now();systemStatus('ready','Alpine Linux ready');
        window.WorkbenchStartup?.linuxReady();
        $('refresh').disabled=false;$('backup').disabled=false;$('save').disabled=!currentPath;
        if(!diagnostics.frames)$('view-placeholder').querySelector('p').textContent='Running ./ex1…';
        if(!diagnostics.filesIndexed)refresh();fit();editor.checkExternal().catch(error=>notice(error.message));
      } else if(['glvis','glvis-command','glvis-end'].includes(message.event)) {
        simulation.handle(message).then(()=>{if(diagnostics.firstRenderMs===null&&diagnostics.frames){diagnostics.firstRenderMs=performance.now();window.WorkbenchStartup?.visualReady()}}).catch(error=>{window.WorkbenchStartup?.error('GLVis: '+(error.message||error));notice('GLVis: '+(error.message||error))});
      } else if(message.event==='operation-progress') {
        const task=waiting.get(message.id);if(task){task.touch();task.onProgress?.(message)}
      } else if(message.event==='error')notice(message.error);
      else if(waiting.has(message.id)) {
        const task=waiting.get(message.id);waiting.delete(message.id);clearTimeout(task.timer);
        message.error?task.reject(new Error(message.error)):task.resolve(message.result);
      }
    } catch(error){console.error('Guest bridge:',error,line)}
  }
});
let previousTerminalSize='';
function fit() {
  const element=$('terminal');
  if(element.clientWidth&&element.clientHeight) {
    const geometry=WorkbenchThemes.terminalGeometry?.(terminal)||{width:7.83,height:15};
    const cols=Math.max(20,Math.floor((element.clientWidth-25)/geometry.width)),rows=Math.max(5,Math.floor((element.clientHeight-20)/geometry.height));
    const size=cols+','+rows;
    if(previousTerminalSize!==size){terminal.resize(cols,rows);if(ready)rpc('resize',{cols,rows}).catch(console.error);previousTerminalSize=ready?size:''}
  }
  if($('simulation').clientWidth&&$('simulation').clientHeight)simulation?.resize();
  if($('editor-host').clientWidth)editor?.cm?.refresh();
}
const sizeObserver=new ResizeObserver(()=>requestAnimationFrame(fit));
sizeObserver.observe($('terminal'));sizeObserver.observe($('simulation'));sizeObserver.observe($('editor-host'));
layout=WorkbenchLayout.create({onResize:fit});
document.body.removeAttribute('data-loading-interface');
offline=WorkbenchOffline.mount({container:document.querySelector('header nav')});
WorkbenchThemes.mount(document.querySelector('header nav'));
function cacheDirectory(path,files) {
  directories.set(path,files);
  for(const file of files)fileMetadata.set(path+'/'+file.name,file);
}
const indexReady=fetch(asset('vm/files-index.json')).then(response=>{
  if(!response.ok)throw new Error('Source index unavailable');return response.json();
}).then(index=>{
  for(const [path,files] of Object.entries(index))cacheDirectory(path,files);
  diagnostics.filesIndexed=true;return renderDirectory(sourceRoot,$('tree'),0);
}).catch(error=>{console.warn(error.message);if(ready)refresh()});
indexReady.then(async()=>{
  if(!editor.buffers.size) {
    await editor.open(sourceRoot+'/examples/ex1.cpp',undefined,undefined,{focus:false});
    if(diagnostics.filesOpenMs===null)diagnostics.filesOpenMs=performance.now();
  }
}).catch(error=>notice('Unable to open ex1.cpp: '+error.message));
async function revealCreatedFile(path) {
  const parent=path.slice(0,path.lastIndexOf('/'));
  if(parent!==sourceRoot&&!parent.startsWith(sourceRoot+'/'))return;
  let directory=parent;
  while(directory.length>sourceRoot.length){expanded.add(directory);directory=directory.slice(0,directory.lastIndexOf('/'));}
  await refresh();
  [...document.querySelectorAll('#tree button')].find(row=>row.title===path)?.scrollIntoView({block:'nearest'});
}
async function renderDirectory(path,container,depth) {
  let files=directories.get(path);
  if(!files&&ready){files=await rpc('list',{path});cacheDirectory(path,files)}
  if(!files)return;
  container.replaceChildren();
  for(const file of files) {
    const filePath=path+'/'+file.name;
    const row=document.createElement('button'),child=document.createElement('div');
    row.textContent=(file.dir?(expanded.has(filePath)?'▾ ':'▸ '):'  ')+file.name;
    row.style.paddingLeft=(10+depth*14)+'px';row.title=filePath;
    if(currentPath===filePath)row.classList.add('selected');container.append(row,child);
    if(file.dir&&expanded.has(filePath))await renderDirectory(filePath,child,depth+1);
    row.onclick=async()=>{
      try {
        if(file.dir) {
          if(expanded.has(filePath)){expanded.delete(filePath);child.hidden=true;row.textContent='▸ '+file.name}
          else {expanded.add(filePath);row.textContent='▾ '+file.name;child.hidden=false;if(!child.childElementCount)await renderDirectory(filePath,child,depth+1)}
        } else if(file.size>editorLimit)notice('Use the terminal for files larger than 3 MB.');
        else await openFile(filePath);
      } catch(error){notice(error.message)}
    };
  }
}
async function refresh(rethrow=false) {
  if(!ready){await indexReady;return}
  $('refresh').disabled=true;
  try {
    const listing=await rpc('list-many',{paths:[sourceRoot,...expanded]});
    for(const [path,files] of Object.entries(listing))cacheDirectory(path,files);
    await renderDirectory(sourceRoot,$('tree'),0);await editor.checkExternal();
  } catch(error){if(rethrow)throw error;notice(error.message)}finally{$('refresh').disabled=false}
}
async function openFile(path) {
  await editor.open(path);
  layout?.selectPane('editor');
  if(diagnostics.filesOpenMs===null)diagnostics.filesOpenMs=performance.now();
}
async function openDiagnostic(file,line,column=1,cwd=terminalCwd) {
  const candidates=file.startsWith('/')?[file]:[...new Set([cwd,sourceRoot,sourceRoot+'/examples'].map(base=>decodeURIComponent(new URL(file,'file://'+base+'/').pathname)))];
  let failure;
  for(const path of candidates) {
    try {
      const result=await readEditorFile(path);
      await editor.open(path,result.text,result.revision);await editor.goTo(path,Number(line),Number(column));
      if(layout.state.maximized==='terminal'||layout.state.maximized==='viewer')layout.maximize(null);
      layout?.selectPane('editor');editor.focus();return true;
    } catch(error){failure=error}
  }
  notice('Cannot open '+file+': '+failure.message);return false;
}
terminal.registerLinkProvider({provideLinks(row,callback){
  const buffer=terminal.buffer.active,text=buffer.getLine(row-1)?.translateToString(true)||'';
  const expression=/((?:\/|\.{1,2}\/)?[\w.+/-]+\.(?:cpp|hpp|cxx|cc|c|h|hh|hxx|tpp)):(\d+)(?::(\d+))?/g;
  let cwd=terminalCwd;
  for(let i=row-2;i>=Math.max(0,row-200);i--) {
    const prior=buffer.getLine(i)?.translateToString(true)||'';
    const make=prior.match(/Entering directory ['`]([^'`]+)['`]/);
    if(make){cwd=make[1];break}
    const prompt=prior.match(/^mfem\s+(?:•\s*)?(~(?:\/\S*)?|\/\S+)/);
    if(prompt){cwd=prompt[1].replace(/^~/,'/root');break}
  }
  const links=[];let match;
  while((match=expression.exec(text))) {
    const [label,file,line,column]=match;
    links.push({text:label,range:{start:{x:match.index+1,y:row},end:{x:match.index+label.length,y:row}},activate:()=>openDiagnostic(file,line,column||1,cwd),decorations:{pointerCursor:true,underline:true}});
  }
  callback(links);
}});
$('save').onclick=()=>editor.save();
$('refresh').onclick=async()=>{
  const activity=WorkbenchOperations.start('Refresh files',{label:'Reading workspace folders…',delay:700});
  try{await refresh(true);activity.complete('Files refreshed')}catch(error){activity.fail(error)}
};
function setWorkspaceBusy(value) {
  workspaceBusy=value;$('backup').disabled=value||!ready;$('import').disabled=value;
  $('import').closest('label').setAttribute('aria-disabled',String(value));
}
function archiveProgress(activity) {
  const labels={waiting:'Waiting for the other workspace operation…',scanning:'Finding source, data and results…',packing:'Compressing workspace…',validating:'Checking the archive…',restoring:'Restoring workspace files…'};
  return ({stage,completed,total,unit,detail})=>activity.update({stage,label:labels[stage]||'Working…',completed,total,unit,detail});
}
function readImport(file,activity) {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    activity.update({stage:'reading',label:'Reading '+file.name+'…',completed:0,total:file.size,unit:'bytes'});
    reader.onprogress=event=>activity.update({completed:event.loaded,total:event.lengthComputable?event.total:null});
    reader.onload=()=>resolve(new Uint8Array(reader.result));
    reader.onerror=()=>reject(reader.error||new Error('Unable to read the archive'));
    reader.onabort=()=>reject(new Error('Reading the archive was interrupted'));
    reader.readAsArrayBuffer(file);
  });
}
$('backup').onclick=async()=>{
  if(workspaceBusy)return;
  setWorkspaceBusy(true);
  const activity=WorkbenchOperations.start('Export workspace',{label:'Saving editor files…'});
  let path;
  try {
    if(!(await editor.saveAll()))throw new Error('Resolve editor conflicts before exporting.');
    activity.update({stage:'scanning',label:'Finding source, data and results…'});
    path=await rpc('export',{},archiveProgress(activity));
    activity.update({stage:'download',label:'Preparing the browser download…'});
    const bytes=await vm.read_file(path.slice(1));
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/gzip'}));
    const link=document.createElement('a');link.href=url;link.download='mfem-workspace-'+new Date().toISOString().slice(0,10)+'.tar.gz';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),60000);activity.complete('Archive ready · browser download started');notice('Workspace archive ready. Keep the downloaded archive to import in a later session.');
  } catch(error){activity.fail(error);notice(error.message)}
  finally{if(path)rpc('unlink',{path}).catch(()=>{});setWorkspaceBusy(false)}
};
$('import').onchange=async event=>{
  const file=event.target.files[0];if(!file)return;
  if(workspaceBusy){event.target.value='';return}
  let activity,uploaded,started=false;
  try {
    if(!ready)throw new Error('Wait for Linux to finish starting');
    if(!confirm('Import overlays files in /root/mfem. Unsaved editor tabs are kept. Continue?'))return;
    setWorkspaceBusy(true);restoringWorkspace=true;started=true;activity=WorkbenchOperations.start('Import workspace',{label:'Reading archive…'});
    await Promise.allSettled([...editor.buffers.values()].flatMap(buffer=>[buffer.saving,buffer.checking]).filter(Boolean));
    const bytes=await readImport(file,activity);
    activity.update({stage:'upload',label:'Copying the archive into Linux…'});
    uploaded=await upload(bytes);
    activity.update({stage:'validating',label:'Checking the archive…'});
    await rpc('restore',{upload:uploaded},archiveProgress(activity));uploaded=null;restoringWorkspace=false;
    activity.update({stage:'refreshing',label:'Refreshing files and editor tabs…'});
    directories.clear();expanded.clear();await refresh(true);
    activity.complete('Workspace restored');notice('Workspace restored. Run make in the terminal to rebuild changed code.');
  } catch(error){activity?.fail(error);notice(error.message)}
  finally{if(uploaded)rpc('unlink',{path:uploaded}).catch(()=>{});if(started){restoringWorkspace=false;setWorkspaceBusy(false)}event.target.value=''}
};
const checkEditor=()=>{if(ready&&!restoringWorkspace&&!document.hidden)editor.checkExternal().catch(error=>console.warn(error.message))};
setInterval(checkEditor,4000);window.addEventListener('focus',checkEditor);
window.addEventListener('beforeunload',event=>{if(ready||dirty){event.preventDefault();event.returnValue='Export your workspace to preserve changes.'}});
window.addEventListener('unhandledrejection',event=>notice(event.reason?.message||String(event.reason)));
