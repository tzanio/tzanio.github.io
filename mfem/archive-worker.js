/* Native gzip and read-only tar/session preflight with bounded input/output.
   The guest still validates every path, link and session hash before extraction. */
'use strict';
class UnsupportedArchive extends Error {}
async function inspectSession(bytes,maximum){
  const decoder=new TextDecoder('utf-8',{fatal:true}),name='mfem-workbench-session.json';
  const block=512,sessionLimit=32*1024*1024;
  let offset=0,count=0,extensions=0,last=0,session=null,pax=null;
  let globals=Object.create(null);
  const bad=message=>{throw new Error('Invalid workspace archive: '+message)};
  function progress(final=false){
    const now=performance.now();
    if(!offset||final||now-last>=100){postMessage({kind:'progress',stage:'validating',completed:final?bytes.length:offset,total:bytes.length,unit:'bytes',detail:'Reading saved session'});last=now}
  }
  function text(data){
    try{return decoder.decode(data)}catch{throw new UnsupportedArchive('Non-UTF-8 tar names')}
  }
  function field(start,length){
    let end=start;while(end<start+length&&bytes[end]!==0)end++;
    return text(bytes.subarray(start,end));
  }
  function octal(start,length){
    if(bytes[start]&0x80)throw new UnsupportedArchive('GNU binary numeric field');
    const value=field(start,length).trim();
    if(value&&!/^[0-7]+$/.test(value))bad('invalid numeric header');
    const result=value?parseInt(value,8):0;
    if(!Number.isSafeInteger(result))bad('oversized numeric header');
    return result;
  }
  function decimal(value){
    if(!/^\d+$/.test(value))bad('invalid PAX member size');
    const result=Number(value);if(!Number.isSafeInteger(result))bad('oversized PAX member size');
    return result;
  }
  function parsePax(start,size){
    // Unusual producer extensions fall back to Python's full tar implementation.
    if(size>1024*1024)throw new UnsupportedArchive('Large PAX header');
    const result=Object.create(null),end=start+size;let cursor=start;
    while(cursor<end){
      let space=cursor;while(space<end&&bytes[space]>=48&&bytes[space]<=57)space++;
      if(space===cursor||bytes[space]!==32)bad('invalid PAX record');
      const length=Number(text(bytes.subarray(cursor,space))),next=cursor+length;
      if(!Number.isSafeInteger(length)||length<5||next>end||next<=space+1||bytes[next-1]!==10)bad('invalid PAX record length');
      let equals=space+1;while(equals<next-1&&bytes[equals]!==61)equals++;
      if(equals===space+1||equals>=next-1)bad('invalid PAX key');
      const key=text(bytes.subarray(space+1,equals)),value=text(bytes.subarray(equals+1,next-1));
      if(key.startsWith('GNU.sparse.')||(key==='hdrcharset'&&value==='BINARY'))throw new UnsupportedArchive('Extended tar encoding');
      result[key]=value;cursor=next;
    }
    return result;
  }
  progress();
  while(offset+block<=bytes.length){
    let nonzero=false;for(let i=offset;i<offset+block;i++)if(bytes[i]){nonzero=true;break}
    if(!nonzero){if(pax)bad('PAX header has no following member');progress(true);return {supported:true,session}}
    const checksum=octal(offset+148,8);let unsigned=256,signed=256;
    for(let i=0;i<block;i++)if(i<148||i>=156){const value=bytes[offset+i];unsigned+=value;signed+=value<128?value:value-256}
    if(checksum!==unsigned&&checksum!==signed)bad('header checksum mismatch');
    const magic=field(offset+257,6);
    if(magic!=='ustar'&&magic!=='ustar ')throw new UnsupportedArchive('Legacy tar header');
    let memberName=field(offset,100),size=octal(offset+124,12);
    const type=String.fromCharCode(bytes[offset+156]),prefix=field(offset+345,155);
    if(['L','K','S'].includes(type))throw new UnsupportedArchive('GNU long-name or sparse header');
    if(!['\0','0','1','2','3','4','5','6','7','x','g'].includes(type))throw new UnsupportedArchive('Unknown tar member type');
    if(prefix)memberName=prefix+'/'+memberName;
    const dataOffset=offset+block;
    if(type==='x'||type==='g'){
      if(++extensions>100000)bad('too many extended headers');
      if(pax)throw new UnsupportedArchive('Chained PAX headers');
      if(size>maximum||dataOffset+size>bytes.length)bad('truncated extended header');
      const parsed=parsePax(dataOffset,size);
      if(type==='g'){
        // Python applies global size metadata after choosing the next physical
        // header offset; retain its implementation for this uncommon variant.
        if(parsed.size!==undefined)throw new UnsupportedArchive('Global PAX size');
        globals=Object.assign(Object.create(null),globals,parsed);
      }else pax=parsed;
      offset=dataOffset+Math.ceil(size/block)*block;progress();continue;
    }
    if(++count>100000)bad('too many entries (maximum 100000)');
    const attributes=Object.assign(Object.create(null),globals,pax||{});pax=null;
    if(attributes.path!==undefined)memberName=attributes.path.replace(/\/+$/,'');
    if(memberName.includes('\0'))bad('NUL in member name');
    if(attributes.size!==undefined)size=decimal(attributes.size);
    let regular=['\0','0','7'].includes(type);
    // Old V7-style regular directory entries are still recognized by tarfile.
    if(type==='\0'&&memberName.endsWith('/'))regular=false;
    if(!regular&&size)throw new UnsupportedArchive('Non-regular tar payload');
    if(!regular)memberName=memberName.replace(/\/+$/,'');
    if(size>maximum||dataOffset+size>bytes.length)bad('truncated or oversized member');
    if(memberName===name){
      if(session)bad('duplicate session metadata');
      if(!regular||size>sessionLimit)bad('invalid session metadata member');
      const payload=bytes.slice(dataOffset,dataOffset+size);let value;
      try{value=JSON.parse(text(payload).replace(/^\ufeff/,''))}catch{bad('invalid session metadata JSON')}
      if(!value||typeof value!=='object'||Array.isArray(value)||value.format!=='mfem-workbench-session'||value.version!==1)bad('unsupported workbench session format');
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',payload));
      session={bytes:payload,sha256:Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('')};
    }
    offset=dataOffset+(regular?Math.ceil(size/block)*block:0);progress();
  }
  // A canonical exported tar contains at least one complete zero header. Fall
  // back for historical tar producers that omit it instead of guessing at EOF.
  throw new UnsupportedArchive('Tar archive without an end marker');
}
self.onmessage=async event=>{
  const {operation,bytes,maximum}=event.data;
  try{
    if(!['pack','unpack','inspect'].includes(operation)||!(bytes instanceof Uint8Array)||!Number.isSafeInteger(maximum)||maximum<=0||maximum>512*1024*1024||bytes.length>maximum)throw new Error('Invalid archive request.');
    if(operation==='inspect'){
      try{
        const result=await inspectSession(bytes,maximum);
        postMessage({kind:'result',result},result.session?[result.session.bytes.buffer]:[]);
      }catch(error){if(error instanceof UnsupportedArchive)postMessage({kind:'result',result:{supported:false}});else throw error}
      return;
    }
    const compress=operation==='pack',stage=compress?'compressing':'unpacking';
    const label=compress?'Compressing the browser download…':'Decompressing the archive…';
    let completed=0,last=0;
    function progress(final=false){
      const now=performance.now();
      if(!completed||final||now-last>=100){postMessage({kind:'progress',stage,label,completed,total:bytes.length,unit:'bytes'});last=now}
    }
    progress();
    const source=new ReadableStream({pull(controller){
      const end=Math.min(bytes.length,completed+64*1024);
      if(end>completed){controller.enqueue(bytes.subarray(completed,end));completed=end;progress()}
      if(completed===bytes.length)controller.close();
    }});
    const transformed=source.pipeThrough(compress?new CompressionStream('gzip'):new DecompressionStream('gzip'));
    const reader=transformed.getReader(),chunks=[];let size=0;
    try{
      while(true){
        const {value,done}=await reader.read();if(done)break;
        size+=value.byteLength;
        if(size>maximum){await reader.cancel();throw new Error('Archive exceeds the '+Math.round(maximum/1048576)+' MiB '+(compress?'compressed':'expanded')+'-size limit. Export fewer generated results and try again.')}
        chunks.push(value);
      }
    }finally{reader.releaseLock()}
    const result=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength}
    progress(true);postMessage({kind:'result',bytes:result},[result.buffer]);
  }catch(error){postMessage({kind:'result',error:error?.message||'Unable to process the archive.'})}
};
