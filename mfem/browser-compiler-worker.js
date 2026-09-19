/* Optional prototype: both compiler and ELF linker execute in this worker. */
'use strict';
let compiler,linkerModule,memfsModule,baseFiles,assets,initializing;
const root='vendor/browser-compiler/';
const url=name=>new URL(root+name+(assets?.[root+name]?'?v='+assets[root+name]:''),self.location.href).href;
let log='';
const output=text=>{log+=text.endsWith('\n')?text:text+'\n'};
const bytes=encoded=>Uint8Array.from(atob(encoded),character=>character.charCodeAt(0));
async function unpack(buffer){return JSON.parse(await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).text())}
async function initialize(){
  if(compiler)return;
  if(initializing)return initializing;
  initializing=(async()=>{
    const names=['Compiler.wasm','Compiler.data','alpine-sdk.json.gz','lld','memfs'];
    const provenance=await(await fetch(new URL('provenance/browser-compiler.json'+(assets?.['provenance/browser-compiler.json']?'?v='+assets['provenance/browser-compiler.json']:''),self.location.href))).json();
    const total=names.reduce((sum,name)=>sum+provenance.files[name].bytes,0);let loaded=0;
    const values=await Promise.all(names.map(async name=>{
      const response=await fetch(url(name));if(!response.ok)throw new Error('Compiler download failed: '+name);
      const reader=response.body.getReader(),chunks=[];let size=0;
      while(true){const item=await reader.read();if(item.done)break;chunks.push(item.value);size+=item.value.length;loaded+=item.value.length;postMessage({kind:'progress',stage:'download',completed:loaded,total,unit:'bytes',label:'Downloading optional browser compiler…'})}
      const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length}const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',result))].map(value=>value.toString(16).padStart(2,'0')).join('');if(hash!==provenance.files[name].sha256)throw new Error('Compiler download checksum failed: '+name+'. Reload and retry.');return result;
    }));
    postMessage({kind:'progress',stage:'initialize',label:'Preparing Clang and LLD…'});
    const createCompiler=(await import(url('Compiler.mjs'))).default;
    const data=values[1];
    compiler=await createCompiler({wasmBinary:values[0],getPreloadedPackage:()=>data.buffer,locateFile:name=>url(name),print:output,printErr:output});
    const targets=compiler.ccall('available_targets','string',[],[]);if(!targets.split(',').includes('x86'))throw new Error('Browser compiler lacks the x86 target');
    baseFiles=await unpack(values[2]);
    for(const file of baseFiles)if(file.path.startsWith('/sysroot/'))write(file.path,bytes(file.data));
    [linkerModule,memfsModule]=await Promise.all([WebAssembly.compile(values[3]),WebAssembly.compile(values[4])]);
    importScripts(url('shared.js'));
  })();
  try{await initializing}catch(error){initializing=null;compiler=null;throw error}
}
function write(path,data){compiler.FS.mkdirTree(path.slice(0,path.lastIndexOf('/'))||'/');compiler.FS.writeFile(path,data)}
function remove(path){try{const info=compiler.FS.lstat(path);if(compiler.FS.isDir(info.mode)){for(const child of compiler.FS.readdir(path))if(child!=='.'&&child!=='..')remove(path+'/'+child);compiler.FS.rmdir(path)}else compiler.FS.unlink(path)}catch{}}
const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
self.onmessage=async event=>{
  const message=event.data;if(message.kind!=='build')return;assets=message.assets;log='';
  try{
    await initialize();log='';
    const input=await unpack(message.input);remove('/root/mfem');
    for(const file of input.files)if(!file.path.endsWith('/libmfem.so.4.10'))write(file.path,bytes(file.data));
    const flags=['clang++','--target=i586-alpine-linux-musl','--sysroot=/sysroot','-resource-dir=/lib/clang/23','-std=c++17','-O'+input.optimization,'-fPIC','-nostdinc++','-isystem','/sysroot/usr/include/c++/14.2.0','-isystem','/sysroot/usr/include/c++/14.2.0/i586-alpine-linux-musl','-isystem','/sysroot/usr/include/c++/14.2.0/backward','-I/root/mfem','-c',input.source,'-o','/program.o'];
    postMessage({kind:'progress',stage:'compile',label:'Compiling with browser Clang…'});
    const begin=performance.now(),status=compiler.ccall('run_command','number',['string'],[flags.map(quote).join(' ')]),compileMs=performance.now()-begin;
    if(status!==0)throw new Error('Clang returned '+status+'; the previous executable is unchanged');
    postMessage({kind:'progress',stage:'link',label:'Linking with browser LLD…'});
    const linkStart=performance.now();
    const api=new API({compileStreaming:async name=>name==='memfs'?memfsModule:linkerModule,readBuffer:async()=>new Uint8Array(1024),hostWrite:output});
    await api.ready;
    for(const file of baseFiles)if(file.path.startsWith('/link/'))api.memfs.addFile(file.path.slice(6),bytes(file.data));
    const mfem=input.files.find(file=>file.path==='/root/mfem/libmfem.so.4.10');if(!mfem)throw new Error('MFEM library missing from input snapshot');
    api.memfs.addFile('libmfem.so',bytes(mfem.data));api.memfs.addFile('program.o',compiler.FS.readFile('/program.o'));
    await api.run(linkerModule,'ld.lld','-m','elf_i386','--dynamic-linker','/lib/ld-musl-i386.so.1','-rpath','/root/mfem','--hash-style=sysv','crt1.o','crti.o','program.o','libmfem.so','libstdc++.so','libgcc_s.so','libc.so','crtn.o','-o','program');
    const result=new Uint8Array(api.memfs.getFileContents('program')).slice(),linkMs=performance.now()-linkStart;
    postMessage({kind:'complete',job:message.job,result,log,timings:{compileMs,linkMs}},[result.buffer]);
  }catch(error){postMessage({kind:'failed',job:message.job,error:error.message||String(error),log})}
};
