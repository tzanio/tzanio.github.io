/* Pane sizes are browser preferences, independent of workspace files. */
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
      phonePane:'viewer',
    };
    const body = document.body, main = document.querySelector('main');
    const work = document.querySelector('.work'), upper = document.querySelector('.upper');
    const panes = {editor:document.querySelector('.editor'),terminal:document.querySelector('.console'),viewer:document.querySelector('.viewer')};
    const abort = new AbortController();
    const coarse = matchMedia('(any-pointer:coarse)');
    function isCompact() {
      const width=document.documentElement.clientWidth||innerWidth;
      const touch=coarse.matches||navigator.maxTouchPoints>0;
      // Some phone browser modes expose a tablet-sized layout viewport. The
      // screen's short edge remains the device's CSS size, without UA sniffing.
      const screenEdge=Math.min(screen.width||Infinity,screen.height||Infinity);
      return width<=600||(touch&&screenEdge<=600);
    }
    let compact=isCompact();
    let resizeFrame = 0;
    function resize() {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {onResize();window.dispatchEvent(new Event('workbench-layout'))});
    }
    function remember() {
      const {maximized, phonePane, ...preferences} = state;
      try {localStorage.setItem(key,JSON.stringify(preferences))} catch {}
    }
    function apply() {
      compact=isCompact();
      if(compact&&state.maximized)state.phonePane=state.maximized;
      body.style.setProperty('--files-width',state.files+'px');
      body.style.setProperty('--editor-size',(state.editor*100)+'%');
      body.style.setProperty('--terminal-size',(state.terminal*100)+'%');
      body.classList.toggle('files-hidden',state.filesHidden);
      if (state.maximized) body.dataset.maximized=state.maximized;
      else delete body.dataset.maximized;
      if (compact) body.dataset.phonePane=state.phonePane;
      else {delete body.dataset.phonePane;closeMenu()}
      for(const [name,button] of Object.entries(phoneButtons)) button.setAttribute('aria-pressed',String(name===state.phonePane));
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
    filesButton.addEventListener('click',()=>{if(compact){selectPane('files');return}state.filesHidden=!state.filesHidden;remember();apply()},{signal:abort.signal});
    const phoneNav=document.createElement('nav');phoneNav.className='phone-panes';phoneNav.setAttribute('aria-label','Workspace panes');
    const phoneButtons={};
    for(const [name,label] of Object.entries({files:'Files',editor:'Editor',viewer:'GLVis',terminal:'Terminal'})) {
      const button=document.createElement('button');button.textContent=label;button.dataset.phonePane=name;
      button.setAttribute('aria-controls',name==='files'?'tree':name==='viewer'?'simulation':name==='editor'?'editor-host':'terminal');
      button.addEventListener('click',()=>selectPane(name),{signal:abort.signal});phoneButtons[name]=button;phoneNav.append(button);
    }
    main.after(phoneNav);
    const menuButton=document.createElement('button');menuButton.className='phone-menu';menuButton.textContent='⋯';
    menuButton.setAttribute('aria-label','Workspace menu');menuButton.setAttribute('aria-expanded','false');
    const headerNav=document.querySelector('header nav');headerNav.id='workspace-menu';menuButton.setAttribute('aria-controls',headerNav.id);
    document.querySelector('header').append(menuButton);
    const activityObserver=new MutationObserver(()=>{
      const active=headerNav.querySelector('#activity-toggle')?.dataset.active==='true';
      menuButton.dataset.busy=String(active);
      menuButton.setAttribute('aria-label',active?'Workspace menu · operation in progress':'Workspace menu');
    });
    activityObserver.observe(headerNav,{childList:true,subtree:true,attributes:true,attributeFilter:['data-active']});
    function closeMenu({restoreFocus=false}={}){
      body.classList.remove('phone-menu-open');menuButton.setAttribute('aria-expanded','false');
      if(restoreFocus)menuButton.focus({preventScroll:true});
    }
    function focusMenu(){
      [...headerNav.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled])')].find(item=>item.getClientRects().length)?.focus({preventScroll:true});
    }
    menuButton.addEventListener('click',()=>{const open=body.classList.toggle('phone-menu-open');menuButton.setAttribute('aria-expanded',String(open))},{signal:abort.signal});
    menuButton.addEventListener('keydown',event=>{
      if(!compact||event.shiftKey||event.altKey||event.ctrlKey||event.metaKey)return;
      if(event.key==='ArrowDown'||(event.key==='Tab'&&body.classList.contains('phone-menu-open'))){
        event.preventDefault();body.classList.add('phone-menu-open');menuButton.setAttribute('aria-expanded','true');focusMenu();
      }
    },{signal:abort.signal});
    headerNav.addEventListener('keydown',event=>{
      if(!compact||event.key!=='Tab')return;
      const items=[...headerNav.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled])')].filter(item=>item.getClientRects().length);
      if(event.target===(event.shiftKey?items[0]:items.at(-1))){event.preventDefault();closeMenu({restoreFocus:true})}
    },{signal:abort.signal});
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&body.classList.contains('phone-menu-open')&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();closeMenu({restoreFocus:true})}
    },{signal:abort.signal});
    headerNav.addEventListener('click',event=>{if(event.target.closest('button,.button'))closeMenu()},{signal:abort.signal});
    document.addEventListener('pointerdown',event=>{if(!event.target.closest('header'))closeMenu()},{signal:abort.signal});
    function selectPane(name) {
      if(!phoneButtons[name]||!compact)return;
      state.phonePane=name;state.maximized=null;closeMenu();apply();
    }
    function viewportSize() {
      // visualViewport follows the iPhone keyboard and collapsing browser chrome.
      const next=isCompact();
      if(next!==compact){compact=next;apply()}
      if(compact&&window.visualViewport&&Math.abs(visualViewport.scale-1)<.05)body.style.setProperty('--phone-height',visualViewport.height+'px');
      else body.style.removeProperty('--phone-height');
      resize();
    }
    coarse.addEventListener('change',viewportSize,{signal:abort.signal});
    window.addEventListener('resize',viewportSize,{signal:abort.signal});
    window.addEventListener('orientationchange',viewportSize,{signal:abort.signal});
    window.visualViewport?.addEventListener('resize',viewportSize,{signal:abort.signal});
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
      handle.addEventListener('pointerup',end,{signal:abort.signal});handle.addEventListener('pointercancel',end,{signal:abort.signal});handle.addEventListener('lostpointercapture',end,{signal:abort.signal});
      handle.addEventListener('dblclick',()=>{reset(name);remember();apply()},{signal:abort.signal});
      handle.addEventListener('keydown',event=>{
        const positive=vertical?'ArrowRight':'ArrowDown',negative=vertical?'ArrowLeft':'ArrowUp';
        if(event.key==='Home'){event.preventDefault();reset(name)}
        else if(event.key===positive||event.key===negative){event.preventDefault();change(null,(event.key===positive?1:-1)*(event.shiftKey?3:1))}
        else return;
        remember();apply();
      },{signal:abort.signal});
      handle.setAttribute('aria-valuemin',name==='files-separator'?'140':name==='editor-separator'?'20':'15');handle.setAttribute('aria-valuemax',name==='files-separator'?'480':name==='editor-separator'?'80':'75');
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
      if(compact&&name){state.phonePane=name;state.maximized=state.maximized===name?null:name;apply();return}
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
    apply();viewportSize();
    return {get state(){return {...state}},maximize,selectPane,resize,destroy(){abort.abort();activityObserver.disconnect();cancelAnimationFrame(resizeFrame);handles.forEach(({element})=>element.remove());Object.values(maxButtons).forEach(button=>button.remove());filesButton.remove();phoneNav.remove();menuButton.remove();delete body.dataset.phonePane;body.style.removeProperty('--phone-height')}};
  }
};
