/* Native gzip outside the emulated CPU; one short-lived worker per archive. */
'use strict';
(function(){
  const HARD_LIMIT=512*1024*1024;
  const supported=typeof Worker==='function'&&typeof CompressionStream==='function'&&typeof DecompressionStream==='function';
  function limit(options){
    const value=options.maxBytes??HARD_LIMIT;
    if(!Number.isSafeInteger(value)||value<=0||value>HARD_LIMIT)throw new Error('Invalid archive size limit.');
    return value;
  }
  function run(operation,bytes,options={}){
    return new Promise((resolve,reject)=>{
      let maximum;
      try{
        maximum=limit(options);
        if(!(bytes instanceof Uint8Array))throw new Error('Archive input must be bytes.');
        if(bytes.byteLength>maximum)throw new Error('Archive exceeds the '+Math.round(maximum/1048576)+' MiB size limit. Export fewer generated results and try again.');
        // Uncompressed .tar files retain the same validation in the guest.
        if(operation==='unpack'&&(bytes[0]!==0x1f||bytes[1]!==0x8b)){resolve(bytes);return}
        if(!supported)throw new Error('Native archive compression is unavailable in this browser.');
      }catch(error){reject(error);return}
      const name='archive-worker.js',url=new URL(name,document.baseURI);
      if(window.WorkbenchAssets?.[name])url.searchParams.set('v',WorkbenchAssets[name]);
      let worker;
      try{worker=new Worker(url)}catch(error){reject(error);return}
      const finish=(error,result)=>{worker.terminate();error?reject(error):resolve(result)};
      worker.onmessage=event=>{
        if(event.data.kind==='progress'){options.onProgress?.(event.data);return}
        finish(event.data.error?new Error(event.data.error):null,event.data.result??event.data.bytes);
      };
      worker.onerror=event=>{event.preventDefault();finish(new Error(event.message||'Archive processing stopped. Close unused tabs and retry.'))};
      worker.onmessageerror=()=>finish(new Error('Unable to transfer the processed archive.'));
      // VM reads can return slices. Transfer only this archive, never unrelated
      // bytes in a larger backing buffer. The caller relinquishes this input.
      if(bytes.byteOffset||bytes.byteLength!==bytes.buffer.byteLength)bytes=bytes.slice();
      // Inspection only reads headers and metadata. Keep the caller's archive
      // attached because the subsequent upload uses this exact byte sequence.
      try{worker.postMessage({operation,bytes,maximum},operation==='inspect'?[]:[bytes.buffer])}catch(error){finish(error)}
    });
  }
  async function unpack(input,options={}){
    if(input instanceof Blob){
      const maximum=limit(options);
      if(input.size>maximum)throw new Error('Archive exceeds the '+Math.round(maximum/1048576)+' MiB size limit.');
      const progress=completed=>options.onProgress?.({stage:'reading',completed,total:input.size,unit:'bytes',detail:input.name||''});
      progress(0);
      input=await new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onprogress=event=>progress(event.loaded);
        reader.onload=()=>{progress(input.size);resolve(new Uint8Array(reader.result))};
        reader.onerror=()=>reject(reader.error||new Error('Unable to read the archive.'));
        reader.onabort=()=>reject(new Error('Reading the archive was interrupted.'));
        reader.readAsArrayBuffer(input);
      });
    }
    return run('unpack',input,options);
  }
  async function inspectSession(bytes,options={}){
    if(!supported||!globalThis.crypto?.subtle)return {supported:false};
    // Older-browser imports may still carry gzip; their guest preflight remains
    // responsible for decompression and metadata validation.
    if(bytes instanceof Uint8Array&&bytes[0]===0x1f&&bytes[1]===0x8b)return {supported:false};
    return run('inspect',bytes,options);
  }
  window.WorkbenchArchive=Object.freeze({supported,maxBytes:HARD_LIMIT,pack:(bytes,options)=>run('pack',bytes,options),unpack,inspectSession});
})();
