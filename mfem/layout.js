/* Pane sizes are preferences only; guest files still require workspace export. */
'use strict';
window.WorkbenchLayout = {
  create({onResize = () => {}} = {}) {
    const key = 'mfem-workbench.layout.v1';
    const defaults = {files:224, editor:0.5, terminal:0.36, filesHidden:false};
    let saved;
    try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
    const clamp = (value, low, high, fallback) => Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : fallback;
    const state = {
      files:clamp(saved?.files,140,480,defaults.files),
      editor:clamp(saved?.editor,0.2,0.8,defaults.editor),
      terminal:clamp(saved?.terminal,0.15,0.75,defaults.terminal),
      filesHidden:saved?.filesHidden === true,
      maximized:null,
    };
    const body = document.body, main = document.querySelector('main');
    const work = document.querySelector('.work'), upper = document.querySelector('.upper');
    const panes = {editor:document.querySelector('.editor'),terminal:document.querySelector('.console'),viewer:document.querySelector('.viewer')};
    const abort = new AbortController();
    let resizeFrame = 0;
    function resize() {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {onResize();window.dispatchEvent(new Event('workbench-layout'))});
    }
    function remember() {
      const {maximized, ...preferences} = state;
      try {localStorage.setItem(key,JSON.stringify(preferences))} catch {}
    }
    function apply() {
      body.style.setProperty('--files-width',state.files+'px');
      body.style.setProperty('--editor-size',(state.editor*100)+'%');
      body.style.setProperty('--terminal-size',(state.terminal*100)+'%');
      body.classList.toggle('files-hidden',state.filesHidden);
      if (state.maximized) body.dataset.maximized=state.maximized;
      else delete body.dataset.maximized;
      filesButton.setAttribute('aria-expanded',String(!state.filesHidden));
      for(const [name,button] of Object.entries(maxButtons)) {
        const active=state.maximized===name;
        button.setAttribute('aria-pressed',String(active));
        button.title=(active?'Restore layout':'Maximize '+(name==='viewer'?'visualization':name))+' (Alt+Shift+'+({editor:'E',terminal:'T',viewer:'V'}[name])+')';
        button.setAttribute('aria-label',active?'Restore layout':('Maximize '+(name==='viewer'?'visualization':name)));
        button.textContent=active?'↙':'⤢';
      }
      for(const handle of handles) handle.update();
      resize();
    }
    const filesButton=document.createElement('button');
    filesButton.id='toggle-files';filesButton.textContent='Files';
    filesButton.title='Show or hide files (Alt+Shift+B)';filesButton.setAttribute('aria-controls','tree');
    document.querySelector('header nav').prepend(filesButton);
    filesButton.addEventListener('click',()=>{state.filesHidden=!state.filesHidden;remember();apply()},{signal:abort.signal});
    const maxButtons={};
    for(const [name,pane] of Object.entries(panes)) {
      const button=pane.querySelector('[data-maximize="'+name+'"]')||document.createElement('button');button.classList.add('pane-maximize');button.dataset.maximize=name;
      if(!button.isConnected)pane.querySelector('.bar').append(button);maxButtons[name]=button;
      button.addEventListener('click',()=>maximize(name),{signal:abort.signal});
    }
    const handles=[];
    function separator(name,parent,before,vertical,getValue,change,describe) {
      const handle=document.createElement('div');handle.className='pane-separator '+name;
      handle.tabIndex=0;handle.setAttribute('role','separator');handle.setAttribute('aria-orientation',vertical?'vertical':'horizontal');
      handle.setAttribute('aria-label',describe);handle.title=describe+' · drag or use arrow keys; double-click to reset';
      parent.insertBefore(handle,before);
      const update=()=>{const n=getValue();handle.setAttribute('aria-valuenow',String(Math.round(n)));handle.setAttribute('aria-valuetext',Math.round(n)+(name==='files-separator'?' pixels':' percent'))};
      handles.push({element:handle,update});
      let pointer=null;
      handle.addEventListener('pointerdown',event=>{
        if(event.button!==0)return;
        pointer=event.pointerId;handle.setPointerCapture(pointer);body.classList.add('resizing-panes');
        handle.focus({preventScroll:true});event.preventDefault();
      },{signal:abort.signal});
      handle.addEventListener('pointermove',event=>{
        if(pointer!==event.pointerId)return;
        change(event);apply();
      },{signal:abort.signal});
      const end=()=>{if(pointer===null)return;pointer=null;body.classList.remove('resizing-panes');remember();resize()};
      handle.addEventListener('pointerup',end,{signal:abort.signal});handle.addEventListener('lostpointercapture',end,{signal:abort.signal});
      handle.addEventListener('dblclick',()=>{reset(name);remember();apply()},{signal:abort.signal});
      handle.addEventListener('keydown',event=>{
        const positive=vertical?'ArrowRight':'ArrowDown',negative=vertical?'ArrowLeft':'ArrowUp';
        if(event.key==='Home'){event.preventDefault();reset(name)}
        else if(event.key===positive||event.key===negative){event.preventDefault();change(null,(event.key===positive?1:-1)*(event.shiftKey?3:1))}
        else return;
        remember();apply();
      },{signal:abort.signal});
      handle.setAttribute('aria-valuemin',name==='files-separator'?'140':'15');handle.setAttribute('aria-valuemax',name==='files-separator'?'480':'80');
    }
    separator('files-separator',main,work,true,()=>state.files,(event,delta)=>{
      const available=Math.min(480,Math.max(140,main.clientWidth-500));
      state.files=clamp(event?event.clientX-main.getBoundingClientRect().left:state.files+delta*12,140,available,224);
    },'File pane width');
    separator('editor-separator',upper,panes.viewer,true,()=>state.editor*100,(event,delta)=>{
      state.editor=clamp(event?(event.clientX-upper.getBoundingClientRect().left)/upper.clientWidth:state.editor+delta*.025,.2,.8,.5);
    },'Editor and visualization split');
    separator('terminal-separator',work,panes.terminal,false,()=>state.terminal*100,(event,delta)=>{
      state.terminal=clamp(event?(work.getBoundingClientRect().bottom-event.clientY)/work.clientHeight:state.terminal-delta*.025,.15,.75,.36);
    },'Terminal height');
    function reset(name) {
      if(name==='files-separator')state.files=defaults.files;
      if(name==='editor-separator')state.editor=defaults.editor;
      if(name==='terminal-separator')state.terminal=defaults.terminal;
    }
    function maximize(name) {
      if(name!==null&&!panes[name])return;
      state.maximized=state.maximized===name?null:name;apply();
      if(state.maximized==='terminal')document.querySelector('.xterm-helper-textarea')?.focus();
      if(state.maximized==='editor')document.querySelector('.CodeMirror textarea')?.focus();
      if(state.maximized==='viewer')document.getElementById('visual')?.focus();
    }
    document.addEventListener('keydown',event=>{
      if(event.defaultPrevented)return;
      const transient=document.querySelector('.wb-window:not([hidden]),dialog[open],.CodeMirror-dialog,.wb-editor-dialog:not([hidden]),.vis-controls:not([hidden])');
      if(event.key==='Escape'&&state.maximized&&!transient){event.preventDefault();event.stopPropagation();maximize(null);return}
      if(!event.altKey||!event.shiftKey||event.ctrlKey||event.metaKey)return;
      const name={KeyE:'editor',KeyT:'terminal',KeyV:'viewer'}[event.code];
      if(name){event.preventDefault();event.stopPropagation();maximize(name)}
      if(event.code==='KeyB'){event.preventDefault();event.stopPropagation();filesButton.click()}
    },{capture:true,signal:abort.signal});
    apply();
    return {get state(){return {...state}},maximize,resize,destroy(){abort.abort();cancelAnimationFrame(resizeFrame);handles.forEach(({element})=>element.remove());Object.values(maxButtons).forEach(button=>button.remove());filesButton.remove()}};
  }
};
