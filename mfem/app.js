'use strict';
const $ = id => document.getElementById(id);
const asset = path => window.WorkbenchAssets?.[path] ? path + '?v=' + window.WorkbenchAssets[path] : path;
const encoder=new TextEncoder(),decoder=new TextDecoder(),serialDecoder=new TextDecoder();
const sourceRoot='/root/mfem',editorLimit=3*1024*1024;
const localCompute=!!window.WorkbenchLocalConfig;
const systemName=localCompute?'Local compute':'Alpine Linux';
let resolveBackendReady;
const backendReady=new Promise(resolve=>{resolveBackendReady=resolve});
const terminal=new Terminal({cursorBlink:true,fontSize:13,fontFamily:'Menlo, Consolas, monospace',theme:{background:'#0c1118',foreground:'#d0dbe7',cursor:'#a6e7be',black:'#17202b',red:'#f08080',green:'#a6e7be',yellow:'#e9cd87',blue:'#81b5f5',magenta:'#c49be8',cyan:'#83d5db',white:'#d0dbe7'},scrollback:5000});
$('terminal').replaceChildren();
terminal.open($('terminal'));
WorkbenchThemes.bindTerminal(terminal);
terminal.writeln('\x1b[38;5;114m'+(localCompute?'Connecting to local compute':'Starting Linux')+'\x1b[0m');
let linuxReady=false,ready=false,currentPath='',dirty=false,sequence=localCompute?Date.now()*1000:0,serialBuffer='',terminalCwd=sourceRoot+'/examples',workspaceBusy=false,restoringWorkspace=false;
let editor,simulation,layout,offline,workspaces,developerTools,browserCompiler,session;
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
const vm=localCompute?WorkbenchLocalRuntime.create():WorkbenchRuntime.create({preload_files:['lib/ld-musl-i386.so.1','bin/bash','usr/lib/libpython3.12.so.1.0','usr/lib/libgcc_s.so.1'],disable_keyboard:true,disable_mouse:true,wasm_path:'vm/v86.wasm',memory_size:768*1024*1024,vga_memory_size:8*1024*1024,bios:{url:'vm/seabios.bin'},vga_bios:{url:'vm/vgabios.bin'},bzimage:{url:'vm/linux.bin'},initrd:{url:'vm/initrd.gz'},filesystem:{basefs:{url:'vm/fs.json'},baseurl:'vm/fs/'},cmdline:'console=ttyS0 quiet tsc=reliable mitigations=off random.trust_cpu=on init=/init',autostart:true,uart1:true});
if(localCompute){document.querySelector('.system-label').firstChild.textContent='Local compute ';document.querySelector('aside footer').firstChild.textContent='MFEM checkout'}
diagnostics.runtimeMode=vm.mode;
window.workstation={vm,terminal,diagnostics,get ready(){return ready},get editor(){return editor},get simulation(){return simulation},get session(){return session},get layout(){return layout},get offline(){return offline},get workspaces(){return workspaces},get developerTools(){return developerTools},get viewer(){return simulation?.viewer},get controls(){return simulation?.controls},get streams(){return simulation?.streams},openFile,openDiagnostic,rpc};
Object.defineProperty(window,'viewer',{get:()=>simulation?.viewer});
vm.add_listener('serial0-output-bytes',bytes=>terminal.write(bytes));
vm.add_listener('runtime-error',error=>{
  linuxReady=ready=false;systemStatus('error',systemName+' stopped');window.WorkbenchStartup?.error(error.message);notice(error.message);
  setWorkspaceBusy(workspaceBusy);$('save').disabled=true;$('refresh').disabled=true;
  for(const task of waiting.values()){clearTimeout(task.timer);task.reject(error)}waiting.clear();
});
vm.ready.catch(error=>notice(error.message));
vm.add_listener('runtime-warning',error=>notice(error.message));
vm.add_listener('runtime-disconnected',error=>{
  ready=false;systemStatus('error','Local compute disconnected');setWorkspaceBusy(workspaceBusy);$('save').disabled=true;$('refresh').disabled=true;notice(error.message);
});
vm.add_listener('runtime-connected',()=>{
  if(diagnostics.bootMs!==null){linuxReady=ready=true;systemStatus('ready','Local compute connected');setWorkspaceBusy(workspaceBusy);$('save').disabled=!currentPath;$('refresh').disabled=false;refresh().catch(error=>notice(error.message))}
});
function logicalPath(path){const root=vm.info?.workspace;return localCompute&&root&&(path===root||path.startsWith(root+'/'))?sourceRoot+path.slice(root.length):path}
terminal.onData(data=>{if(ready){if(/[\r\n]/.test(data))workspaces?.markPending?.();vm.serial0_send(data)}});
terminal.parser.registerOscHandler(7,data=>{try{const url=new URL(data);if(url.protocol==='file:')terminalCwd=logicalPath(decodeURIComponent(url.pathname))}catch{}return true});
function rpc(op,values={},onProgress) {
  return new Promise((resolve,reject)=>{
    if(!linuxReady){reject(new Error((localCompute?'Local compute is connecting':'Linux is still starting')+'; you can save once it is ready.'));return}
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
  if(linuxReady) {
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
  if(!ready)throw new Error((localCompute?'Local compute is not connected.':'Linux is still starting.')+' Your changes remain in the editor.');
  const uploaded=await upload(encoder.encode(text));
  if(restoringWorkspace){rpc('unlink',{path:uploaded}).catch(()=>{});throw new Error('Wait for workspace import to finish before saving. Your changes remain in the editor.')}
  return rpc('write',{path,upload:uploaded,expected_hash:expectedHash});
}
function syncEditor(state) {
  currentPath=state.path||'';dirty=state.dirty;workspaces?.captureDrafts();
  $('filename').textContent=currentPath?currentPath.replace('/root/','')+(state.activeDirty?' •':''):'Editor';
  $('save').disabled=!ready||!currentPath;
  document.querySelectorAll('#tree button').forEach(row=>row.classList.toggle('selected',row.title===currentPath));
}
editor=WorkbenchEditor.create($('editor-host'),{
  readFile:readEditorFile,writeFile:writeEditorFile,isReady:()=>ready,onNotice:notice,onChange:syncEditor,
  getDefaultDirectory:()=>currentPath?currentPath.slice(0,currentPath.lastIndexOf('/')):sourceRoot+'/examples',
  onSaved:({path,created})=>{workspaces?.markPending?.();if(created)revealCreatedFile(path).catch(error=>notice(error.message));},
});
simulation=SimulationWorkbench.create($('simulation'),{rpc,readFile:path=>vm.read_file(path.slice(1)),upload,notice,diagnostics,startupPreview:asset('startup-ex1.json')});
simulation.previewReady.then(shown=>{if(shown){diagnostics.previewRenderMs=performance.now();window.WorkbenchStartup?.visualReady()}else{window.WorkbenchStartup?.error(diagnostics.previewError||'Saved GLVis scene unavailable. Run ./ex1 from the terminal or reload.')}}).catch(error=>{window.WorkbenchStartup?.error('GLVis preview: '+error.message);notice(error.message)});
async function finishStartup() {
  await initialEditorReady;
  await workspaces.start();
  ready=true;diagnostics.bootMs=performance.now();systemStatus('ready',systemName+' ready');
  window.WorkbenchStartup?.linuxReady();simulation.setGuestReady?.(true);
  $('refresh').disabled=false;setWorkspaceBusy(false);$('save').disabled=!currentPath;
  await refresh();fit();
}
vm.add_listener('serial1-output-bytes',bytes=>{
  serialBuffer+=serialDecoder.decode(bytes,{stream:true});
  let end;
  while((end=serialBuffer.indexOf('\n'))>=0) {
    const line=serialBuffer.slice(0,end);serialBuffer=serialBuffer.slice(end+1);
    try {
      const message=JSON.parse(line);
      if(message.event==='ready') {
        linuxReady=true;
        resolveBackendReady();
        finishStartup().catch(error=>{systemStatus('error','Workspace needs attention');window.WorkbenchStartup?.error(error.message);notice(error.message)});
      } else if(['glvis','glvis-command','glvis-end'].includes(message.event)) {
        simulation.handle(message).then(()=>{if(diagnostics.firstRenderMs===null&&diagnostics.frames){diagnostics.firstRenderMs=performance.now();window.WorkbenchStartup?.visualReady()}}).catch(error=>{window.WorkbenchStartup?.error('GLVis: '+(error.message||error));notice('GLVis: '+(error.message||error))});
      } else if(message.event==='browser-build'||message.event==='browser-build-cancel') {browserCompiler?.handle(message);
      } else if(message.event==='workspace-dirty') {workspaces?.handleGuestEvent(message);
      } else if(message.event==='operation-progress') {
        const task=waiting.get(message.id);if(task){task.touch();task.onProgress?.(message)}
      } else if(message.event==='transport-gap')notice(message.message||'Some terminal output expired while disconnected. Native jobs were not restarted.');
      else if(message.event==='error')notice(message.error);
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
offline=localCompute?null:WorkbenchOffline.mount({container:document.querySelector('header nav')});
WorkbenchThemes.mount(document.querySelector('header nav'));
window.WorkbenchCompute?.mount({runtime:vm,notice});
workspaces=localCompute?WorkbenchLocalWorkspace.mount({editor,runtime:vm,notice,onStatus:state=>{diagnostics.workspace=state}}):WorkbenchWorkspaces.mount({rpc,journal:vm,readFile:path=>vm.read_file(path.replace(/^\//,'')),upload,editor,
  onRestore:()=>{directories.clear();expanded.clear()},
  onStatus:state=>{diagnostics.workspace=state;if(!ready&&['restoring','error'].includes(state.state))WorkbenchStartup?.workspace(state.label+(state.detail?' · '+state.detail:''))},
});
browserCompiler=localCompute?null:WorkbenchBrowserCompiler.mount({rpc,readFile:path=>vm.read_file(path.replace(/^\//,'')),upload,notice});
developerTools=WorkbenchDeveloperTools.mount({rpc,readFile:path=>vm.read_file(path.replace(/^\//,'')),editor,terminal,notice,allowBundles:!localCompute,
  openFile,isReady:()=>ready,getCwd:()=>terminalCwd,getRuntime:()=>({mfem:'4.10',mode:vm.mode,...(localCompute?{platform:vm.info?.platform}:{memoryMiB:768}),userAgent:navigator.userAgent}),
});
session=WorkbenchSession.create({editor,layout,simulation,terminal,rpc,getCwd:()=>terminalCwd,
  getFiles:()=>({expanded:[...expanded],scrollTop:$('tree').scrollTop}),
  restoreFiles:async state=>{
    directories.clear();expanded.clear();for(const path of state.expanded)expanded.add(path);
    await refresh(true);$('tree').scrollTop=Math.max(0,Number(state.scrollTop)||0);
  },
});
function cacheDirectory(path,files) {
  directories.set(path,files);
  for(const file of files)fileMetadata.set(path+'/'+file.name,file);
}
const indexReady=(localCompute?backendReady.then(async()=>({[sourceRoot]:await rpc('list',{path:sourceRoot})})):fetch(asset('vm/files-index.json')).then(response=>{
  if(!response.ok)throw new Error('Source index unavailable');return response.json();
})).then(index=>{
  for(const [path,files] of Object.entries(index))cacheDirectory(path,files);
  diagnostics.filesIndexed=true;return renderDirectory(sourceRoot,$('tree'),0);
}).catch(error=>{console.warn(error.message);if(ready)refresh()});
const initialEditorReady=indexReady.then(async()=>{
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
    if(file.dir)row.setAttribute('aria-expanded',String(expanded.has(filePath)));
    row.style.paddingLeft=(10+depth*14)+'px';row.title=filePath;
    if(currentPath===filePath)row.classList.add('selected');container.append(row,child);
    if(file.dir&&expanded.has(filePath))await renderDirectory(filePath,child,depth+1);
    row.onclick=async()=>{
      try {
        if(file.dir) {
          if(expanded.has(filePath)){expanded.delete(filePath);row.setAttribute('aria-expanded','false');child.hidden=true;row.textContent='▸ '+file.name}
          else {expanded.add(filePath);row.setAttribute('aria-expanded','true');row.textContent='▾ '+file.name;child.hidden=false;if(!child.childElementCount)await renderDirectory(filePath,child,depth+1)}
        } else if(file.size>editorLimit)notice('Use the terminal for files larger than 3 MB.');
        else await openFile(filePath);
      } catch(error){notice(error.message)}
    };
  }
}
async function refresh(rethrow=false) {
  if(!ready){await indexReady;return}
  const focusedRefresh=document.activeElement===$('refresh');
  $('refresh').disabled=true;
  try {
    const listing=await rpc('list-many',{paths:[sourceRoot,...expanded]});
    for(const [path,files] of Object.entries(listing))cacheDirectory(path,files);
    const tree=$('tree'),scroll=tree.scrollTop,focusedPath=tree.contains(document.activeElement)?document.activeElement.title:null;
    await renderDirectory(sourceRoot,tree,0);
    tree.scrollTop=scroll;
    if(focusedPath&&document.activeElement===document.body)[...tree.querySelectorAll('button')].find(row=>row.title===focusedPath)?.focus({preventScroll:true});
    await editor.checkExternal();
  } catch(error){if(rethrow)throw error;notice(error.message)}finally{
    $('refresh').disabled=!ready;
    if(focusedRefresh&&document.activeElement===document.body)$('refresh').focus({preventScroll:true});
  }
}
async function openFile(path) {
  await editor.open(path);
  layout?.selectPane('editor');
  if(diagnostics.filesOpenMs===null)diagnostics.filesOpenMs=performance.now();
}
async function openDiagnostic(file,line,column=1,cwd=terminalCwd) {
  file=logicalPath(file);cwd=logicalPath(cwd);
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
  workspaceBusy=value;
  if(!value)workspaces?.resumeFilesystem?.();
  for(const id of ['backup','import','import-open'])$(id).disabled=value||!ready;
}
function archiveProgress(activity) {
  const labels={waiting:'Waiting for the other workspace operation…',checkpoint:'Checking changed files…',scanning:'Finding source, data and results…',packing:'Preparing workspace archive…',compressing:'Compressing archive in the browser…',unpacking:'Opening compressed archive…',reading:'Reading archive…',validating:'Checking the archive…',restoring:'Restoring workspace files…'};
  return ({stage,completed,total,unit,detail})=>activity.update({stage,label:labels[stage]||'Working…',completed,total,unit,detail});
}
function archiveLimit(){return (matchMedia('(any-pointer:coarse)').matches?256:512)*1024*1024}
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
  const activity=WorkbenchOperations.start('Export workspace',{label:'Capturing open tabs and session…'});
  let path,sessionUpload;
  try {
    await workspaces?.suspendFilesystem?.();
    const saved=await session.capture();sessionUpload=await upload(saved.bytes);
    activity.update({stage:'scanning',label:'Finding source, data and results…'});
    const journal=await vm.getWorkspaceWrites?.();
    // In local mode the host streams and compresses archives. Keep large Git
    // histories out of the renderer's ArrayBuffer/decompression working set.
    const nativeArchive=!localCompute&&window.WorkbenchArchive?.supported;
    const exported=await rpc('export',{written_paths:journal?.paths||[],session_upload:sessionUpload,
      ...(localCompute?{compression:'gzip',max_bytes:archiveLimit()}:nativeArchive?{compression:'none',max_bytes:archiveLimit()}:{})},archiveProgress(activity));
    path=typeof exported==='string'?exported:exported.path;
    saved.warnings.push(...(exported.warnings||[]));
    activity.update({stage:'download',label:'Preparing the browser download…'});
    let bytes=localCompute?await vm.read_blob(path.slice(1)):await vm.read_file(path.slice(1));
    if(nativeArchive){
      await rpc('unlink',{path});path=null;
      bytes=await WorkbenchArchive.pack(bytes,{maxBytes:archiveLimit(),onProgress:archiveProgress(activity)});
    }
    activity.update({stage:'download',label:'Preparing the browser download…'});
    WorkbenchOperations.download(activity,bytes,'mfem-workspace-'+new Date().toISOString().slice(0,10)+'.tar.gz',{
      detail:['Includes files, layout, editor tabs/drafts, terminal and displayed GLVis data. Exact cameras and animation history are not included.',...saved.warnings].join(' '),
    });notice(saved.warnings.length?saved.warnings.join(' '):'Workspace and session archive ready. Download it again from Activity.');
  } catch(error){activity.fail(error,{retry:()=>$('backup').onclick()});notice(error.message)}
  finally{for(const temporary of [path,sessionUpload])if(temporary)rpc('unlink',{path:temporary}).catch(()=>{});setWorkspaceBusy(false)}
};
async function importArchive(file,confirmed=false) {
  if(!file||workspaceBusy)return;
  let activity,uploaded,sessionPath,started=false;
  try {
    if(!ready)throw new Error(localCompute?'Connect to local compute before importing.':'Wait for Linux to finish starting');
    if(!confirmed&&!confirm('Import restores workspace files, including recorded deletions, and any saved layout, tabs, terminal output and GLVis data. Older archives restore files only. Your current unsaved editor text is kept. Continue?'))return;
    setWorkspaceBusy(true);restoringWorkspace=true;started=true;activity=WorkbenchOperations.start('Import workspace',{label:'Reading archive…'});
    await workspaces?.suspendFilesystem?.();
    await Promise.allSettled([...editor.buffers.values()].flatMap(buffer=>[buffer.saving,buffer.checking]).filter(Boolean));
    if(file.size>archiveLimit())throw new Error('This archive exceeds this device’s '+archiveLimit()/1048576+' MiB import limit.');
    const bytes=localCompute?file:window.WorkbenchArchive?.supported?
      await WorkbenchArchive.unpack(file,{maxBytes:archiveLimit(),onProgress:archiveProgress(activity)}):await readImport(file,activity);
    activity.update({stage:'validating',label:'Checking the archive…'});
    const nativeInspection=localCompute?null:await window.WorkbenchArchive?.inspectSession?.(bytes,{maxBytes:archiveLimit(),onProgress:archiveProgress(activity)});
    let savedSession=null;
    if(nativeInspection?.supported&&nativeInspection.session)savedSession=session.validate(JSON.parse(decoder.decode(nativeInspection.session.bytes)));
    activity.update({stage:'upload',label:localCompute?'Sending the archive to local compute…':'Copying the archive into Linux…'});
    uploaded=await upload(bytes);
    const inspected=nativeInspection?.supported?nativeInspection.session:await rpc('session-inspect',{upload:uploaded},archiveProgress(activity));
    if(inspected&&!nativeInspection?.supported){
      sessionPath=inspected.session_path;
      savedSession=session.validate(JSON.parse(decoder.decode(await vm.read_file(sessionPath.slice(1)))));
      await rpc('unlink',{path:sessionPath});sessionPath=null;
    }
    const journal=await vm.getWorkspaceWrites?.();
    const restored=await rpc('restore',{upload:uploaded,written_paths:journal?.paths||[],expected_session_hash:inspected?.sha256||null},archiveProgress(activity));uploaded=null;restoringWorkspace=false;
    sessionPath=restored?.session_path;
    activity.update({stage:'refreshing',label:'Refreshing files and editor tabs…'});
    let warnings=restored?.warnings||[];
    if(savedSession){
      activity.update({stage:'refreshing',label:'Restoring layout, tabs, terminal and saved visualization…'});
      warnings.push(...await session.restore(savedSession));workspaces?.captureDrafts();fit();
    }else{directories.clear();expanded.clear();await refresh(true)}
    const detail=savedSession?'Session restored. At the shell prompt, press Ctrl+C to clear current input and apply its history and directory. No saved commands are executed.':'Workspace files restored.';
    activity.complete('Workspace restored',{detail:[detail,...warnings].join(' '),persistent:warnings.length>0});notice(warnings.length?warnings.join(' '):detail);
  } catch(error){activity?.fail(error,{retry:()=>importArchive(file,true)});notice(error.message)}
  finally{for(const temporary of [uploaded,sessionPath])if(temporary)rpc('unlink',{path:temporary}).catch(()=>{});if(started){restoringWorkspace=false;setWorkspaceBusy(false)}}
}
$('import-open').onclick=()=>$('import').click();
$('import').onchange=event=>{const file=event.target.files[0];event.target.value='';importArchive(file)};
const checkEditor=()=>{if(ready&&!restoringWorkspace&&!document.hidden)editor.checkExternal().catch(error=>console.warn(error.message))};
setInterval(checkEditor,4000);window.addEventListener('focus',checkEditor);
window.addEventListener('beforeunload',event=>{if(workspaces?.hasPendingChanges?.() || (!workspaces && dirty)){event.preventDefault();event.returnValue='Workspace changes are still being saved.'}});
window.addEventListener('unhandledrejection',event=>notice(event.reason?.message||String(event.reason)));
