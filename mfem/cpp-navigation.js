/* Local MFEM declaration lookup and identifier completion; no language server. */
'use strict';
(function () {
  const cppPath=/\.(cpp|cxx|cc|c|hpp|hxx|hh|h|inl|tpp)$/;
  const types=new Set(['class','struct','enum','union','alias']);
  let releasePromise;
  function releaseIndex() {
    if(!releasePromise)releasePromise=(async()=>{
      const url=new URL('vm/symbols-index.json',location.href),version=window.WorkbenchAssets?.['vm/symbols-index.json'];
      if(version)url.searchParams.set('v',version);
      const response=await fetch(url);if(!response.ok)throw new Error('The MFEM symbol index could not be loaded.');
      const data=await response.json();if(data.schema!==1)throw new Error('Unsupported MFEM symbol index.');
      return {files:data.files,symbols:data.symbols.map(item=>({name:item[0],path:data.files[item[1]].path,line:item[2],column:item[3],kind:item[4],scope:item[5],definition:Boolean(item[6])}))};
    })().catch(error=>{releasePromise=null;throw error;});
    return releasePromise;
  }
  function create(editor,{host,onNotice=()=>{}}) {
    const cm=editor.cm,cache=new WeakMap(),history=[],abort=new AbortController();
    let destroyed=false,pending=0,rows=[],selected=0,exact='',completion=null,searchTimer;
    const toolbar=host.querySelector('.wb-editor-actions');
    function button(text,title,action){const item=document.createElement('button');item.type='button';item.textContent=text;item.title=title;item.addEventListener('click',action,{signal:abort.signal});toolbar.insertBefore(item,toolbar.querySelector('[data-action="keys"]'));return item;}
    const symbolsButton=button('Symbols','Search C++ symbols (Cmd/Ctrl+Shift+O)',()=>showSymbols());
    const definitionButton=button('Definition','Go to definition (F12 or Cmd/Ctrl+click)',()=>goDefinition());
    const completeButton=button('Complete','Complete an identifier (Ctrl+Space)',()=>showCompletion());
    const backButton=button('←','Back to previous code location (Alt+←)',()=>goBack());backButton.setAttribute('aria-label','Previous code location');backButton.disabled=true;
    const panel=document.createElement('section');panel.className='wb-cpp-symbols';panel.innerHTML='<div class="wb-cpp-query"><input aria-label="Find C++ symbol" placeholder="Find a symbol, e.g. Mesh or GetNE" autocomplete="off" spellcheck="false"><select aria-label="Symbol scope"><option value="all">All MFEM</option><option value="file">Current file</option></select></div><p class="wb-cpp-count" role="status"></p><div class="wb-cpp-results" role="listbox" aria-label="C++ symbols"></div><p class="wb-cpp-note">Source declarations + open buffers. Overloads are listed; C++ types and macros are not resolved.</p>';
    const input=panel.querySelector('input'),scopeSelect=panel.querySelector('select'),list=panel.querySelector('.wb-cpp-results'),count=panel.querySelector('.wb-cpp-count');
    const symbolWindow=WorkbenchWindows.attach(panel,{title:'C++ symbols',width:580,anchor:symbolsButton,initialFocus:input,returnFocus:()=>cm.getInputField()});
    const completionPanel=document.createElement('section');completionPanel.className='wb-cpp-completion';completionPanel.innerHTML='<p class="wb-cpp-completion-context"></p><div class="wb-cpp-results" role="listbox" aria-label="Identifier completions" tabindex="0"></div><p class="wb-cpp-note">↑ / ↓ to choose · Enter to insert · Esc to cancel</p>';
    const completionList=completionPanel.querySelector('.wb-cpp-results');
    const completeWindow=WorkbenchWindows.attach(completionPanel,{title:'Complete identifier',width:420,anchor:completeButton,initialFocus:completionList,returnFocus:()=>cm.getInputField(),onClose:()=>{completion=null;}});
    function report(error){if(!destroyed)onNotice(error?.message||String(error));}
    function liveSymbols(){
      const result=[],paths=new Set();
      for(const buffer of editor.buffers.values())if(cppPath.test(buffer.path)){
        paths.add(buffer.path);const generation=buffer.doc.changeGeneration();let entry=cache.get(buffer.doc);
        if(!entry||entry.generation!==generation){entry={generation,symbols:WorkbenchCppIndex.parse(buffer.doc.getValue(),buffer.path)};cache.set(buffer.doc,entry);}
        result.push(...entry.symbols);
      }
      return {result,paths};
    }
    async function allSymbols(){const release=await releaseIndex(),live=liveSymbols();return [...live.result,...release.symbols.filter(item=>!live.paths.has(item.path))];}
    function score(item,query){
      const name=item.name.toLowerCase(),qualified=(item.scope+'::'+item.name).toLowerCase();
      if(!query)return (types.has(item.kind)?0:10)+(item.path===editor.path?-5:0);
      let rank=name===query?0:name.startsWith(query)?10:qualified.includes(query)?25:name.includes(query)?30:Infinity;
      if(rank===Infinity&&query.length>=3){let index=0;for(const char of name)if(char===query[index])index++;if(index===query.length)rank=50;}
      return rank+(item.path===editor.path?-3:0)+(types.has(item.kind)?0:2)+(item.definition?0:1);
    }
    function selectRow(container,index){
      const buttons=[...container.querySelectorAll('button')];if(!buttons.length)return;
      selected=Math.max(0,Math.min(index,buttons.length-1));
      buttons.forEach((item,i)=>{item.classList.toggle('selected',i===selected);item.setAttribute('aria-selected',String(i===selected));});
      container.setAttribute('aria-activedescendant',buttons[selected].id);buttons[selected].scrollIntoView({block:'nearest'});
    }
    function renderRows(container,items,activate,prefix){
      container.replaceChildren();items.forEach((symbol,index)=>{
        const item=document.createElement('button');item.type='button';item.id=prefix+'-'+index;item.setAttribute('role','option');
        const name=document.createElement('strong');name.textContent=symbol.scope?symbol.scope+'::'+symbol.name:symbol.name;
        const detail=document.createElement('span');detail.textContent=symbol.path?symbol.kind+' · '+symbol.path.replace('/root/mfem/','')+':'+symbol.line:symbol.kind;
        item.append(name,detail);item.addEventListener('click',()=>activate(symbol));container.append(item);
      });selected=0;selectRow(container,0);
    }
    async function search(){
      const ticket=++pending,query=input.value.trim().toLowerCase();count.textContent='Loading symbols…';
      try{
        let symbols=await allSymbols();if(ticket!==pending||destroyed)return;
        if(scopeSelect.value==='file')symbols=symbols.filter(item=>item.path===editor.path);
        if(exact)symbols=symbols.filter(item=>item.name===exact);
        const matches=symbols.map(item=>({item,rank:score(item,query)})).filter(item=>Number.isFinite(item.rank)).sort((a,b)=>a.rank-b.rank||a.item.name.localeCompare(b.item.name)||a.item.path.localeCompare(b.item.path)||a.item.line-b.item.line);
        rows=matches.slice(0,120).map(match=>match.item);renderRows(list,rows,jump,'cpp-symbol');
        count.textContent=matches.length?matches.length+' locations'+(matches.length>120?' · first 120 shown, refine your search':''):'No matching declarations.';
      }catch(error){count.textContent=error.message;report(error);}
    }
    async function showSymbols(query=''){
      exact='';input.value=typeof query==='string'?query:'';scopeSelect.value='all';symbolWindow.open();input.select();await search();
    }
    async function jump(symbol,remember=true){
      try{
        if(remember&&editor.path){history.push({path:editor.path,line:cm.getCursor().line+1,column:cm.getCursor().ch+1});if(history.length>50)history.shift();backButton.disabled=false;}
        await editor.open(symbol.path);
        // Terminal changes can shift line numbers since the packaged index.
        let target=symbol;
        if(symbol.name){const matches=WorkbenchCppIndex.parse(editor.getText(),symbol.path).filter(item=>item.name===symbol.name&&item.kind===symbol.kind);target=matches.sort((a,b)=>(a.scope===symbol.scope?0:100000)-(b.scope===symbol.scope?0:100000)||Math.abs(a.line-symbol.line)-Math.abs(b.line-symbol.line))[0];}
        if(!target){onNotice('This declaration changed on disk. Search the open file for its current location.');return;}
        symbolWindow.close({restoreFocus:false});await editor.goTo(target.path,target.line,target.column);
      }catch(error){report(error);}
    }
    async function goBack(){const location=history.pop();backButton.disabled=!history.length;if(location)await jump(location,false);}
    function wordAt(position=cm.getCursor()){
      const line=cm.getLine(position.line)||'',left=line.slice(0,position.ch).match(/[A-Za-z_\d]*$/)?.[0]||'',right=line.slice(position.ch).match(/^[A-Za-z_\d]*/)?.[0]||'';
      return {name:left+right,prefix:left,from:{line:position.line,ch:position.ch-left.length},to:{line:position.line,ch:position.ch+right.length},before:line.slice(0,position.ch-left.length)};
    }
    function localDefinition(word){
      const clean=WorkbenchCppIndex.mask(editor.getText()),lines=clean.split('\n'),cursor=cm.getCursor();
      const pattern=new RegExp('(?:^|[;{}(]\\s*|\\n\\s*)(?:(?:const|static|constexpr|unsigned|signed|long|short)\\s+)*(?:[A-Za-z_]\\w*(?:::[A-Za-z_]\\w*)*(?:<[^;{}\\n]+>)?)[ \\t*&]+('+word.name+')[ \\t]*(?=[=;,)]|\\()','g');
      const candidates=[];for(const match of clean.matchAll(pattern)){
        const offset=match.index+match[0].lastIndexOf(word.name),prefix=clean.slice(0,offset),line=prefix.split('\n').length,column=offset-prefix.lastIndexOf('\n');
        if(line<=cursor.line+1&&!/^\s*(return|delete|throw)\b/.test(lines[line-1]))candidates.push({name:word.name,path:editor.path,line,column,kind:'local',scope:'',definition:true});
      }
      return candidates.at(-1);
    }
    async function goDefinition(position){
      if(!editor.path)return;
      if(position)cm.setCursor(position);const word=wordAt();if(!word.name)return;
      try{
        const symbols=(await allSymbols()).filter(item=>item.name===word.name);
        const classes=symbols.filter(item=>types.has(item.kind));
        if(classes.length===1){await jump(classes[0]);return;}
        const local=localDefinition(word);
        if(!symbols.length&&local){await jump({...local,name:''});return;}
        if(symbols.length===1){await jump(symbols[0]);return;}
        if(!symbols.length){onNotice('No indexed declaration for '+word.name+'.');return;}
        exact=word.name;input.value=word.name;scopeSelect.value='all';symbolWindow.open();await search();
      }catch(error){report(error);}
    }
    function memberScope(word){
      const qualifier=word.before.match(/([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*(::|->|\.)\s*$/);if(!qualifier)return '';
      if(qualifier[2]==='::')return qualifier[1];
      const clean=WorkbenchCppIndex.mask(editor.getText()),escaped=qualifier[1];
      const declaration=new RegExp('\\b([A-Za-z_]\\w*(?:::[A-Za-z_]\\w*)*)[ \\t*&]+\\b'+escaped+'\\b(?=\\s*[=();,\\[])','g');
      const matches=[...clean.matchAll(declaration)];return matches.at(-1)?.[1]||'';
    }
    async function showCompletion(){
      if(!editor.path)return;
      const word=wordAt(),doc=cm.getDoc(),generation=doc.changeGeneration();
      try{
        const symbols=await allSymbols();if(doc!==cm.getDoc()||generation!==doc.changeGeneration())return;
        const member=memberScope(word),prefix=word.prefix.toLowerCase(),seen=new Set(),choices=[];
        let matches=symbols.filter(item=>item.name.toLowerCase().startsWith(prefix));
        if(member){const filtered=matches.filter(item=>item.scope===member||item.scope.endsWith('::'+member));if(filtered.length)matches=filtered;}
        matches.sort((a,b)=>(a.path===editor.path?-1:0)-(b.path===editor.path?-1:0)||(types.has(a.kind)?0:1)-(types.has(b.kind)?0:1)||a.name.localeCompare(b.name));
        for(const symbol of matches)if(!seen.has(symbol.name)){seen.add(symbol.name);choices.push(symbol);}
        if(!member)for(const match of WorkbenchCppIndex.mask(editor.getText()).matchAll(/\b[A-Za-z_]\w*\b/g))if(match[0].toLowerCase().startsWith(prefix)&&!seen.has(match[0])&&match[0]!==word.name){seen.add(match[0]);choices.push({name:match[0],kind:'open buffer identifier',scope:''});}
        if(!choices.length){onNotice('No completion for '+(word.prefix||'this location')+'.');return;}
        completion={doc,generation,word,choices:choices.slice(0,100)};
        completionPanel.querySelector('.wb-cpp-completion-context').textContent=(member?member+' · ':'')+(word.prefix||'All identifiers')+' · '+choices.length+' choices'+(choices.length>100?' (type more to narrow)':'');
        renderRows(completionList,completion.choices,insert,'cpp-completion');completeWindow.open();
      }catch(error){report(error);}
    }
    function insert(symbol){
      const current=completion;if(!current)return;
      if(cm.getDoc()!==current.doc||current.generation!==current.doc.changeGeneration()){
        completeWindow.close();onNotice('Source changed while choosing a completion. Open Complete again.');return;
      }
      completeWindow.close({restoreFocus:false});cm.replaceRange(symbol.name,current.word.from,current.word.to,'+complete');cm.setCursor({line:current.word.from.line,ch:current.word.from.ch+symbol.name.length});cm.focus();
    }
    function choose(event,container,items,action){
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();selectRow(container,selected+(event.key==='ArrowDown'?1:-1));}
      else if(event.key==='Enter'&&items[selected]){event.preventDefault();action(items[selected]);}
    }
    input.addEventListener('input',()=>{exact='';clearTimeout(searchTimer);searchTimer=setTimeout(search,100);},{signal:abort.signal});
    scopeSelect.addEventListener('change',search,{signal:abort.signal});
    input.addEventListener('keydown',event=>choose(event,list,rows,jump),{signal:abort.signal});
    list.addEventListener('keydown',event=>choose(event,list,rows,jump),{signal:abort.signal});
    completionList.addEventListener('keydown',event=>choose(event,completionList,completion?.choices||[],insert),{signal:abort.signal});
    const keymap={'Shift-Cmd-O':()=>showSymbols(),'Shift-Ctrl-O':()=>showSymbols(),'F12':()=>goDefinition(),'Ctrl-Space':()=>showCompletion(),'Alt-Left':()=>goBack()};cm.addKeyMap(keymap);
    cm.getWrapperElement().addEventListener('mousedown',event=>{
      if((event.metaKey||event.ctrlKey)&&event.button===0){event.preventDefault();const position=cm.coordsChar({left:event.clientX,top:event.clientY},'window');goDefinition(position);}
    },{capture:true,signal:abort.signal});
    // A small static index is fetched only when navigation is first requested.
    return {showSymbols,goDefinition,showCompletion,goBack,allSymbols,releaseIndex,
      destroy(){destroyed=true;pending++;clearTimeout(searchTimer);abort.abort();cm.removeKeyMap(keymap);symbolWindow.destroy();completeWindow.destroy();for(const item of [symbolsButton,definitionButton,completeButton,backButton])item.remove();}};
  }
  window.WorkbenchCppNavigation={create,releaseIndex};
})();
