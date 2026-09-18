/* A small source index, shared by the release builder and live editor buffers.
 * This intentionally indexes declarations without pretending to resolve C++ types. */
'use strict';
(function (root) {
  const identifiers = /^[A-Za-z_]\w*$/;
  const excluded = new Set(['if','for','while','switch','catch','sizeof','alignof','decltype','static_assert','return','defined','noexcept']);
  function mask(text) {
    return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|R"([^ ()\\\t\r\n]*)\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, value => value.replace(/[^\n]/g,' '));
  }
  function parse(text, path = '') {
    const clean = mask(text), starts = [0], symbols = [], seen = new Set();
    for (let i=0;i<text.length;i++) if(text[i]==='\n') starts.push(i+1);
    const source = clean.replace(/^\s*#[^\n]*(?:\\\n[^\n]*)*/gm,value=>value.replace(/[^\n]/g,' '));
    const tokens = [...source.matchAll(/[A-Za-z_]\w*|::|->|&&|[^\s]/g)].map(match=>({value:match[0],offset:match.index}));
    function add(token, kind, scope, definition = true) {
      if (!token || !identifiers.test(token.value) || excluded.has(token.value)) return;
      let lo=0,hi=starts.length;
      while(lo+1<hi){const mid=(lo+hi)>>1;if(starts[mid]<=token.offset)lo=mid;else hi=mid;}
      const key=token.offset+':'+kind;if(seen.has(key))return;seen.add(key);
      symbols.push({name:token.value,path,line:lo+1,column:token.offset-starts[lo]+1,kind,scope:scope.join('::'),definition});
    }
    function describe(chunk, scope, hasBody) {
      if(!chunk.length)return null;
      // Ignore template parameter declarations when finding the actual class.
      let begin=0;
      if(chunk[0].value==='template'&&chunk[1]?.value==='<'){
        let depth=0;
        for(let j=1;j<chunk.length;j++){if(chunk[j].value==='<')depth++;if(chunk[j].value==='>'&&!--depth){begin=j+1;break;}}
      }
      const values=chunk.map(token=>token.value), prefix=values.slice(begin);
      const namespace=prefix.indexOf('namespace');
      if(namespace>=0&&hasBody)return {kind:'namespace',names:chunk.slice(begin+namespace+1).filter(token=>identifiers.test(token.value)).map(token=>token.value)};
      const type=prefix.findIndex(value=>['class','struct','enum','union'].includes(value));
      if(type>=0&&!prefix.slice(0,type).some(value=>['friend','typedef','('].includes(value))){
        let index=begin+type+1;if(chunk[index]?.value==='class'||chunk[index]?.value==='struct')index++;
        const token=chunk[index];
        if(token&&identifiers.test(token.value)&&hasBody){add(token,chunk[begin+type].value,scope);return {kind:'type',names:[token.value]};}
        if(!hasBody&&type===0)return null; // Forward declarations are not definitions.
      }
      const alias=prefix.indexOf('using');
      if(alias>=0&&prefix[alias+2]==='=')add(chunk[begin+alias+1],'alias',scope);
      const typedef=prefix.indexOf('typedef');
      if(typedef>=0){const last=[...chunk].reverse().find(token=>identifiers.test(token.value));add(last,'alias',scope);}
      let parens=0,open=-1,close=-1;
      for(let j=begin;j<chunk.length;j++){
        if(chunk[j].value==='('){if(parens===0&&open<0)open=j;parens++;}
        if(chunk[j].value===')'){parens--;if(parens===0&&open>=0){close=j;break;}}
      }
      if(open>begin&&close>open){
        const token=chunk[open-1], prior=chunk.slice(begin,open-1).map(item=>item.value);
        if(identifiers.test(token.value)&&!excluded.has(token.value)&&!prior.some(value=>['=','.','->','return'].includes(value))){
          // Uppercase-only MFEM macros are not function declarations.
          if(/^[A-Z_][A-Z_\d]+$/.test(token.value))return null;
          const isConstructor=scope.at(-1)===token.value||prior.includes('::');
          if(prior.length||isConstructor){
            const explicit=[];for(let j=open-2;j>begin&&chunk[j].value==='::';j-=2)explicit.unshift(chunk[j-1].value);
            add(token,isConstructor&&(!prior.length||explicit.at(-1)===token.value)?'constructor':'function',explicit.length?[...scope,...explicit]:scope,hasBody);
            return {kind:'function',names:[]};
          }
        }
      }
      return null;
    }
    function walk(start, end, scope) {
      let segment=start;
      for(let i=start;i<end;i++){
        const value=tokens[i].value;
        if(value===';'||value==='{'){
          const info=describe(tokens.slice(segment,i),scope,value==='{');
          if(value==='{'){
            let depth=1,j=i+1;for(;j<end&&depth;j++){if(tokens[j].value==='{')depth++;else if(tokens[j].value==='}')depth--;}
            if(info&&['namespace','type'].includes(info.kind))walk(i+1,j-1,[...scope,...info.names]);
            i=j-1;
          }
          segment=i+1;
        } else if(value===':'&&['public','private','protected'].includes(tokens[i-1]?.value))segment=i+1;
      }
    }
    walk(0,tokens.length,[]);
    for(const match of clean.matchAll(/^\s*#\s*define\s+([A-Za-z_]\w*)/gm))add({value:match[1],offset:match.index+match[0].lastIndexOf(match[1])},'macro',[]);
    return symbols;
  }
  const api={parse,mask};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.WorkbenchCppIndex=api;
})(typeof window==='undefined'?globalThis:window);
