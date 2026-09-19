/* Local multi-buffer CodeMirror editor. See vendor/codemirror/LICENSE. */
'use strict';
(function () {
  const encoder = new TextEncoder();
  async function contentHash(text) {
    const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(text));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function modeFor(path) {
    if (/\.(cpp|cxx|cc|hpp|hxx|hh|h)$/.test(path)) return ['text/x-c++src', 'C++'];
    if (/\.c$/.test(path)) return ['text/x-csrc', 'C'];
    if (/\.py$/.test(path)) return ['python', 'Python'];
    if (/\.(sh|bash)$|\/(\.bashrc|\.profile)$/.test(path)) return ['shell', 'Shell'];
    if (/CMakeLists\.txt$|\.cmake$/.test(path)) return ['cmake', 'CMake'];
    if (/\.json$/.test(path)) return [{name:'javascript', json:true}, 'JSON'];
    if (/\.(js|mjs|cjs)$/.test(path)) return ['javascript', 'JavaScript'];
    return [null, 'Text'];
  }
  function create(host, {readFile, writeFile, isReady = () => true, onNotice = () => {}, onChange = () => {},
    onSaved = () => {}, getDefaultDirectory = () => '/root/mfem/examples'}) {
    if (!window.CodeMirror) throw new Error('The local CodeMirror bundle did not load');
    const buffers = new Map();
    let active = null, opening = 0, checking = null, closeRequest = null, destroyed = false;
    host.classList.add('wb-editor');
    host.innerHTML = '<div class="wb-editor-tabs" role="tablist" aria-label="Open files"></div>' +
      '<div class="wb-editor-actions"><button type="button" data-action="new" title="New file (Alt+Shift+N)">New file</button>' +
      '<button type="button" data-command="findPersistent" title="Find (Cmd/Ctrl+F)">Find</button>' +
      '<button type="button" data-command="replace" title="Replace (Cmd+Option+F / Ctrl+Shift+F)">Replace</button>' +
      '<button type="button" data-command="jumpToLine" title="Go to line (Alt+G)">Go to line</button>' +
      '<button type="button" data-action="keys" title="Editor shortcuts (Alt+Shift+K)" aria-expanded="false">Shortcuts</button></div>' +
      '<form class="wb-editor-dialog wb-editor-new" role="dialog" aria-label="New file" hidden>' +
      '<label>File name or path<input name="path" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="my-example.cpp" required></label>' +
      '<p class="wb-editor-new-directory"></p><p class="wb-editor-new-error" role="alert" hidden></p>' +
      '<div><button type="submit">Create tab</button><button type="button" data-dismiss>Cancel</button></div></form>' +
      '<section class="wb-editor-dialog wb-editor-keys" role="dialog" aria-label="Editor shortcuts" tabindex="-1" hidden>' +
      '<div class="wb-editor-dialog-heading"><strong>Editor shortcuts</strong><button type="button" data-dismiss>Close</button></div>' +
      '<p>Use these while the editor is focused. On Mac, Alt is Option.</p>' +
      '<dl><dt>New file</dt><dd>Alt+Shift+N</dd><dt>Previous / next tab</dt><dd>Alt+Shift+← / →</dd>' +
      '<dt>Close editor tab</dt><dd>Alt+Shift+W</dd><dt>Show shortcuts</dt><dd>Alt+Shift+K</dd>' +
      '<dt>Save / save all</dt><dd>Cmd/Ctrl+S / +Shift+S</dd><dt>Find</dt><dd>Cmd/Ctrl+F</dd>' +
      '<dt>Next / previous match</dt><dd>F3 / Shift+F3</dd><dt>Replace</dt><dd>Cmd+Option+F / Ctrl+Shift+F</dd>' +
      '<dt>Go to line</dt><dd>Alt+G</dd><dt>Indent / outdent</dt><dd>Tab / Shift+Tab</dd>' +
      '<dt>Symbols / definition</dt><dd>Cmd/Ctrl+Shift+O / F12</dd><dt>Complete / back</dt><dd>Ctrl+Space / Alt+←</dd><dt>Toggle comment</dt><dd>Cmd/Ctrl+/</dd><dt>Undo / redo</dt><dd>Cmd/Ctrl+Z / +Shift+Z</dd></dl></section>' +
      '<div class="wb-editor-message" role="status" hidden></div>' +
      '<div class="wb-editor-empty">Open a file from Files, or choose New file above. Each file opens in its own tab.</div>' +
      '<div class="wb-editor-main"></div>' +
      '<div class="wb-editor-status"><span class="wb-editor-language">Text</span><span class="wb-editor-position">Ln 1, Col 1</span><span>UTF-8 · Spaces: 3</span></div>';
    const tabs = host.querySelector('.wb-editor-tabs');
    const message = host.querySelector('.wb-editor-message');
    const newForm = host.querySelector('.wb-editor-new'), newPath = newForm.elements.path;
    const keyHelp = host.querySelector('.wb-editor-keys');
    let submitting = false;
    const cm = CodeMirror(host.querySelector('.wb-editor-main'), {
      value:'', mode:null, theme:'workstation', lineNumbers:true, indentUnit:3,
      tabSize:3, indentWithTabs:false, smartIndent:true, electricChars:true,
      matchBrackets:true, autoCloseBrackets:true, styleActiveLine:true,
      lineWrapping:false, inputStyle:'textarea', autofocus:false, readOnly:true,
      extraKeys:{
        'Cmd-S':() => save(), 'Ctrl-S':() => save(),
        'Shift-Cmd-S':() => saveAll(), 'Shift-Ctrl-S':() => saveAll(),
        'Cmd-F':'findPersistent', 'Ctrl-F':'findPersistent',
        'F3':'findPersistentNext', 'Shift-F3':'findPersistentPrev',
        'Cmd-G':'findPersistentNext', 'Ctrl-G':'findPersistentNext',
        'Shift-Cmd-G':'findPersistentPrev', 'Shift-Ctrl-G':'findPersistentPrev',
        'Cmd-Alt-F':'replace', 'Shift-Ctrl-F':'replace', 'Alt-G':'jumpToLine',
        'Cmd-/':'toggleComment', 'Ctrl-/':'toggleComment',
        'Tab':editor => {
          if (editor.somethingSelected()) editor.indentSelection('add');
          else editor.replaceSelection(' '.repeat(editor.getOption('indentUnit')), 'end', '+input');
        },
        'Shift-Tab':editor => editor.indentSelection('subtract'),
      },
    });
    cm.getInputField().setAttribute('aria-label', 'Source editor');
    cm.getInputField().setAttribute('spellcheck', 'false');
    const newWindow = WorkbenchWindows.attach(newForm, {title:'New file',width:420,
      anchor:host.querySelector('[data-action="new"]'),initialFocus:newPath,returnFocus:() => cm.getInputField()});
    const keysWindow = WorkbenchWindows.attach(keyHelp, {title:'Editor shortcuts',width:470,
      heading:keyHelp.querySelector('.wb-editor-dialog-heading'),anchor:host.querySelector('[data-action="keys"]'),
      returnFocus:() => cm.getInputField(),onClose:() => host.querySelector('[data-action="keys"]').setAttribute('aria-expanded','false')});
    const searchWindows = new Set();
    // Keep CodeMirror's search commands, but put their prompts in movable,
    // modeless windows instead of covering the first source lines.
    function searchPrompt(template, title) {
      for (const item of [...searchWindows]) item.close();
      const panel = document.createElement('div');panel.className = 'CodeMirror-dialog';
      if (typeof template === 'string') panel.innerHTML = template;else panel.append(template);
      if (!title) {
        const text = panel.textContent.trim();
        title = /^Search/.test(text) ? 'Find' : /^Replace/.test(text) ? 'Replace' : /^With/.test(text) ? 'Replace with' : /Jump|line/i.test(text) ? 'Go to line' : 'Editor';
      }
      return {panel,title};
    }
    cm.openDialog = (template, callback, options = {}) => {
      const {panel,title} = searchPrompt(template), input = panel.querySelector('input');
      let closed = false, floating;
      const close = value => {
        if (typeof value === 'string') {if(input)input.value = value;return;}
        if (closed) return;closed = true;
        searchWindows.delete(floating);floating.destroy();cm.focus();options.onClose?.(panel);
      };
      floating = WorkbenchWindows.attach(panel, {title,width:400,anchor:host.querySelector('.wb-editor-actions'),
        initialFocus:input,returnFocus:() => cm.getInputField(),onClose:close});
      searchWindows.add(floating);
      if (input) {
        input.value = options.value || '';
        input.addEventListener('input', event => options.onInput?.(event,input.value,close));
        input.addEventListener('keyup', event => options.onKeyUp?.(event,input.value,close));
        input.addEventListener('keydown', event => {
          if (options.onKeyDown?.(event,input.value,close)) return;
          if (event.key === 'Enter') {
            const value = input.value;
            if (options.closeOnEnter !== false) {event.preventDefault();event.stopPropagation();close();}
            callback(value,event);
          }
        });
      }
      floating.open();
      if (input && options.selectValueOnOpen !== false) input.select();
      return close;
    };
    cm.openConfirm = (template, callbacks) => {
      const {panel} = searchPrompt(template,'Replace matches'), buttons = [...panel.querySelectorAll('button')];
      let closed = false, floating;
      const close = () => {
        if (closed) return;closed = true;searchWindows.delete(floating);floating.destroy();cm.focus();
      };
      buttons.forEach((button,index) => button.addEventListener('click', event => {
        event.preventDefault();close();callbacks[index]?.(cm);
      }));
      floating = WorkbenchWindows.attach(panel,{title:'Replace matches',width:400,
        anchor:host.querySelector('.wb-editor-actions'),initialFocus:buttons[0],onClose:close});
      searchWindows.add(floating);floating.open();
    };

    function state() {
      return {path:active?.path || '', dirty:[...buffers.values()].some(buffer => buffer.dirty),
        activeDirty:Boolean(active?.dirty), conflict:Boolean(active?.conflict),
        buffers:[...buffers.values()].map(buffer => ({path:buffer.path, dirty:buffer.dirty, isNew:buffer.isNew, conflict:Boolean(buffer.conflict)}))};
    }
    function report(error) { onNotice(error?.message || String(error)); }
    function basename(path) { return path.slice(path.lastIndexOf('/') + 1); }
    function publish() {
      if (destroyed) return;
      for (const buffer of buffers.values()) {
        buffer.tab.classList.toggle('active', buffer === active);
        buffer.tab.classList.toggle('conflict', Boolean(buffer.conflict));
        buffer.tabButton.setAttribute('aria-selected', String(buffer === active));
        buffer.tabButton.tabIndex = buffer === active ? 0 : -1;
        buffer.tabButton.textContent = basename(buffer.path) + (buffer.conflict ? ' !' : buffer.dirty ? ' •' : '');
        buffer.tabButton.title = buffer.path + (buffer.conflict ? ' — changed on disk' : buffer.dirty ? ' — unsaved changes' : '');
      }
      host.querySelector('.wb-editor-language').textContent = active ? modeFor(active.path)[1] : 'Text';
      host.querySelector('.wb-editor-main').hidden = !active;
      host.querySelector('.wb-editor-status').hidden = !active;
      host.querySelector('.wb-editor-empty').hidden = Boolean(active);
      host.querySelectorAll('[data-command]').forEach(button=>{button.disabled=!active;});
      cm.setOption('readOnly', !active);
      showMessage();
      onChange(state());
    }
    function position() {
      const cursor = cm.getCursor();
      host.querySelector('.wb-editor-position').textContent = 'Ln ' + (cursor.line + 1) + ', Col ' + (cursor.ch + 1);
    }
    function messageButton(label, action) {
      const button = document.createElement('button');
      button.type = 'button';button.textContent = label;
      button.addEventListener('click', () => Promise.resolve(action()).catch(report));
      message.append(button);
    }
    function showMessage() {
      message.replaceChildren();
      const buffer = active;
      if (closeRequest && closeRequest !== buffer) closeRequest = null;
      if (buffer?.conflict && !closeRequest) {
        const label = document.createElement('span');
        label.textContent = buffer.conflict.deleted ? 'This file was deleted in the terminal. Your editor text is kept.' : buffer.isNew ? 'A file already exists at this path. Your new editor text is kept.' : 'This file changed in the terminal. Your unsaved edits are kept.';
        message.append(label);
        if (!buffer.conflict.deleted) messageButton('Reload from disk', () => reloadConflict(buffer));
        messageButton(buffer.conflict.deleted ? 'Recreate file' : 'Overwrite disk', () => saveBuffer(buffer, true));
      } else if (closeRequest) {
        const label = document.createElement('span');label.textContent = 'Keep changes to ' + basename(buffer.path) + '?';message.append(label);
        messageButton('Save and close', async () => {if(await saveBuffer(buffer)) removeBuffer(buffer);});
        messageButton('Discard changes', () => removeBuffer(buffer));
        messageButton('Cancel', () => {closeRequest=null;publish();cm.focus();});
      }
      message.hidden = !message.childElementCount;
    }
    function activate(buffer, focus = true) {
      if(!submitting)dismissPanels(false);
      active = buffer;closeRequest = null;
      cm.swapDoc(buffer.doc);
      publish();position();cm.refresh();
      if (focus) cm.focus();
      buffer.tab.scrollIntoView({block:'nearest', inline:'nearest'});
    }
    function removeBuffer(buffer) {
      buffers.delete(buffer.path);buffer.tab.remove();
      buffer.doc.off('change', buffer.onChange);
      closeRequest = null;
      if (active === buffer) {
        active = null;
        const next = [...buffers.values()].pop();
        if (next) activate(next);
        else {cm.swapDoc(new CodeMirror.Doc(''));publish();position();host.querySelector('[data-action="new"]').focus();}
      } else publish();
    }
    function requestClose(buffer) {
      if (!buffer.dirty) {removeBuffer(buffer);return;}
      activate(buffer);closeRequest = buffer;publish();
    }
    async function normalize(value) {
      const result = typeof value === 'string' ? {text:value} : value;
      if (!result || typeof result.text !== 'string') throw new Error('File reader did not return text');
      return {text:result.text, revision:result.revision ?? await contentHash(result.text)};
    }
    function acceptDisk(buffer, remote) {
      const cursor = buffer.doc.getCursor();
      const scroll = buffer === active ? cm.getScrollInfo() : {left:buffer.doc.scrollLeft,top:buffer.doc.scrollTop};
      buffer.baseText = remote.text;buffer.revision = remote.revision;buffer.isNew = false;
      buffer.conflict = null;buffer.dirty = false;
      if (buffer.doc.getValue() !== remote.text) {
        buffer.doc.setValue(remote.text);
        buffer.doc.setCursor(cursor);
        if(buffer===active)cm.scrollTo(scroll.left,scroll.top);
        else {buffer.doc.scrollLeft=scroll.left;buffer.doc.scrollTop=scroll.top;}
      }
      publish();
    }
    async function observeDisk(buffer, remote) {
      if (remote.revision === buffer.revision) {if(buffer.conflict){buffer.conflict=null;publish();}return;}
      if (remote.text === buffer.doc.getValue()) {acceptDisk(buffer,remote);return;}
      if (buffer.dirty) {if(buffer.conflict?.revision!==remote.revision||buffer.conflict?.deleted){buffer.conflict=remote;publish();}}
      else {acceptDisk(buffer,remote);onNotice('Reloaded ' + basename(buffer.path) + ' after a terminal change.');}
    }
    function makeBuffer(path, remote, isNew = false) {
      const doc = new CodeMirror.Doc(remote.text, modeFor(path)[0]);
      const tab = document.createElement('div');tab.className='wb-editor-tab';
      const tabButton = document.createElement('button');tabButton.type='button';tabButton.setAttribute('role','tab');
      const close = document.createElement('button');close.type='button';close.className='wb-editor-close';close.textContent='×';close.setAttribute('aria-label','Close '+basename(path));
      tab.append(tabButton,close);tabs.append(tab);
      const buffer = {path,doc,tab,tabButton,baseText:remote.text,revision:remote.revision,isNew,dirty:isNew,conflict:null,saving:null};
      buffer.onChange=()=>{buffer.dirty=buffer.isNew||buffer.doc.getValue()!==buffer.baseText;publish();};
      doc.on('change',buffer.onChange);
      tabButton.addEventListener('click',()=>{activate(buffer);if(isReady())checkBuffer(buffer).catch(report);});
      close.addEventListener('click',()=>requestClose(buffer));
      buffers.set(path,buffer);
      return buffer;
    }
    async function open(path, text, revision, {focus = true} = {}) {
      const ticket = ++opening;
      let buffer = buffers.get(path);
      if (buffer) {
        activate(buffer,focus);
        if (text !== undefined) await observeDisk(buffer, await normalize({text,revision}));
        else if (isReady()) await checkBuffer(buffer);
        return buffer;
      }
      const remote = await normalize(text === undefined ? await readFile(path) : {text,revision});
      // Two asynchronous opens of the same file must still share one document.
      buffer = buffers.get(path);
      if (!buffer) buffer = makeBuffer(path,remote);
      if(ticket===opening)activate(buffer,focus);
      return buffer;
    }
    function normalizePath(value) {
      const name=String(value??'').trim();
      if(!name||/[\x00-\x1f\x7f]/.test(name)||/\/$|(?:^|\/)\.{1,2}$/.test(name))throw new Error('Enter a file name, such as my-example.cpp.');
      const base=String(getDefaultDirectory()||'/root/mfem/examples');
      const expanded=name==='~'?'/root':name.startsWith('~/')?'/root/'+name.slice(2):name;
      const absolute=expanded.startsWith('/')?expanded:base+'/'+expanded;
      const parts=[];
      for(const part of absolute.split('/')) {
        if(!part||part==='.')continue;
        if(part==='..')parts.pop();else parts.push(part);
      }
      if(!parts.length)throw new Error('Enter a file name, not a directory.');
      return '/'+parts.join('/');
    }
    async function newFile(value, {text = '', focus = true} = {}) {
      const path=normalizePath(value), ticket=++opening;
      let buffer=buffers.get(path);
      if(buffer){activate(buffer,focus);onNotice(basename(path)+' is already open.');return buffer;}
      let remote=null;
      try {remote=await normalize(await readFile(path));}
      catch(error) {
        if(isReady()&&!/No such file|not found|ENOENT/i.test(error?.message||String(error)))throw error;
      }
      // Another open may finish during the existence check. Reuse its document.
      buffer=buffers.get(path);
      if(!buffer)buffer=makeBuffer(path,remote||{text:String(text),revision:null},!remote);
      if(ticket===opening)activate(buffer,focus);
      onNotice(remote ? 'Opened existing file '+path+'.' : 'New unsaved file '+path+'. Save with Cmd/Ctrl+S.');
      return buffer;
    }
    function dismissPanels(focus = true) {
      newWindow.close({restoreFocus:false});keysWindow.close({restoreFocus:false});
      host.querySelector('[data-action="keys"]').setAttribute('aria-expanded','false');
      if(focus) {if(active)cm.focus();else host.querySelector('[data-action="new"]').focus();}
    }
    function showNewFile() {
      dismissPanels(false);
      newPath.value='';newPath.removeAttribute('aria-invalid');
      const error=newForm.querySelector('.wb-editor-new-error');error.hidden=true;error.textContent='';
      newForm.querySelector('.wb-editor-new-directory').textContent='Relative paths use '+getDefaultDirectory()+'. Parent folders must already exist. Save creates the file in Linux.';
      newWindow.open();
    }
    function showKeybindings() {
      const wasOpen=!keyHelp.hidden;dismissPanels(false);
      if(wasOpen){if(active)cm.focus();return;}
      keysWindow.open();
      host.querySelector('[data-action="keys"]').setAttribute('aria-expanded','true');
    }
    function nextTab(direction = 1) {
      const list=[...buffers.values()];
      if(list.length)activate(list[(Math.max(0,list.indexOf(active))+direction+list.length)%list.length]);
    }
    async function checkBuffer(buffer) {
      if (!isReady() || buffer.isNew || buffer.saving || !buffers.has(buffer.path)) return;
      if (buffer.checking) return buffer.checking;
      const expected = buffer.revision;
      buffer.checking=(async()=>{
        try {
          const result = await readFile(buffer.path,{ifRevision:expected});
          if (!buffer.saving && buffer.revision === expected && buffers.has(buffer.path)) {
            if(result.unchanged){if(buffer.conflict){buffer.conflict=null;publish();}}
            else await observeDisk(buffer,await normalize(result));
          }
        } catch (error) {
          if (/No such file|not found|ENOENT/i.test(error?.message || String(error))) {
            if(!buffer.conflict?.deleted){buffer.conflict={deleted:true,revision:null};publish();}
          } else throw error;
        }
      })();
      try {await buffer.checking;} finally {buffer.checking=null;}
    }
    async function checkExternal() {
      if (!isReady()) return;
      if (checking) return checking;
      checking=(async()=>{for(const buffer of buffers.values())await checkBuffer(buffer);})();
      try {await checking;} catch(error){report(error);} finally {checking=null;}
    }
    async function reloadConflict(buffer) {
      const remote = await normalize(await readFile(buffer.path));
      acceptDisk(buffer,remote);closeRequest=null;
      onNotice('Reloaded '+basename(buffer.path)+'. Undo can recover the previous editor text.');
      if(buffer===active)cm.focus();
    }
    async function saveBuffer(buffer, overwrite = false) {
      if (!buffer) return false;
      if (!isReady()) {onNotice('Linux is still starting; your editor changes are kept until you can save.');return false;}
      if (buffer.saving) return buffer.saving;
      if (buffer.conflict && !overwrite) {activate(buffer);onNotice('Resolve the disk change before saving '+basename(buffer.path)+'.');return false;}
      const text=buffer.doc.getValue(), expectedHash=overwrite ? buffer.conflict.revision : buffer.revision;
      buffer.saving=(async()=>{
        try {
          const result=await writeFile(buffer.path,text,{expectedHash});
          if(result?.conflict) {
            if(result.revision===null)buffer.conflict={deleted:true,revision:null};
            else {
              const remote=await normalize(await readFile(buffer.path));
              buffer.conflict=remote;
            }
            activate(buffer);publish();
            onNotice('Save stopped: '+basename(buffer.path)+' changed on disk. Your edits are kept.');
            return false;
          }
          buffer.baseText=text;buffer.revision=result?.revision ?? await contentHash(text);buffer.isNew=false;
          buffer.dirty=buffer.doc.getValue()!==text;buffer.conflict=null;publish();
          Promise.resolve().then(()=>onSaved({path:buffer.path,created:expectedHash===null})).catch(report);
          onNotice('Saved '+buffer.path);return true;
        } catch(error){report(error);return false;}
        finally{buffer.saving=null;}
      })();
      return buffer.saving;
    }
    function save() {return saveBuffer(active);}
    async function saveAll() {
      for(const buffer of buffers.values())if(buffer.dirty && !(await saveBuffer(buffer)))return false;
      return true;
    }
    async function goTo(path,line=1,column=1) {
      await open(path);
      const location={line:Math.max(0,Number(line)-1),ch:Math.max(0,Number(column)-1)};
      cm.setCursor(location);cm.scrollIntoView(location,70);cm.focus();
      const markedLine=cm.getCursor().line;
      const handle=cm.addLineClass(markedLine,'background','wb-editor-jump-line');
      setTimeout(()=>cm.removeLineClass(handle,'background','wb-editor-jump-line'),1800);
    }
    host.querySelector('.wb-editor-actions').addEventListener('click',event=>{
      const button=event.target.closest('[data-command]');
      if(button){cm.focus();cm.execCommand(button.dataset.command);}
      const action=event.target.closest('[data-action]')?.dataset.action;
      if(action==='new')showNewFile();else if(action==='keys')showKeybindings();
    });
    newForm.addEventListener('submit',async event=>{
      event.preventDefault();if(submitting)return;
      submitting=true;
      const submit=newForm.querySelector('[type="submit"]'),error=newForm.querySelector('.wb-editor-new-error');
      submit.disabled=true;error.hidden=true;newPath.removeAttribute('aria-invalid');
      try {await newFile(newPath.value);dismissPanels();}
      catch(problem){error.textContent=problem?.message||String(problem);error.hidden=false;newPath.setAttribute('aria-invalid','true');newPath.focus();}
      finally{submitting=false;submit.disabled=false;}
    });
    newForm.querySelectorAll('[data-dismiss]').forEach(button=>button.addEventListener('click',()=>dismissPanels()));
    host.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&(!newForm.hidden||!keyHelp.hidden)) {
        event.preventDefault();event.stopPropagation();dismissPanels();return;
      }
      if(!event.altKey||!event.shiftKey||event.ctrlKey||event.metaKey)return;
      const action={KeyN:showNewFile,KeyK:showKeybindings,KeyW:()=>{if(active)requestClose(active);},ArrowLeft:()=>nextTab(-1),ArrowRight:()=>nextTab(1)}[event.code];
      if(action){event.preventDefault();event.stopPropagation();action();}
    },true);
    tabs.addEventListener('keydown',event=>{
      if(event.altKey||event.ctrlKey||event.metaKey||event.target.getAttribute('role')!=='tab')return;
      const list=[...buffers.values()];let next;
      if(event.key==='ArrowLeft')next=list[(list.indexOf(active)+list.length-1)%list.length];
      else if(event.key==='ArrowRight')next=list[(list.indexOf(active)+1)%list.length];
      else if(event.key==='Home')next=list[0];else if(event.key==='End')next=list[list.length-1];
      if(next){event.preventDefault();activate(next,false);next.tabButton.focus();}
    });
    cm.on('cursorActivity',position);
    cm.on('focus',()=>{if(active&&isReady())checkBuffer(active).catch(report);});
    const observer=new ResizeObserver(()=>cm.refresh());observer.observe(host);
    publish();
    let navigation;
    const api = {open,newFile,showNewFile,showKeybindings,nextTab,closeActive:()=>{if(active)requestClose(active);},save,saveAll,checkExternal,goTo,focus:()=>{if(active)cm.focus();else host.querySelector('[data-action="new"]').focus();},cm,buffers,
      get path(){return active?.path||'';},get dirty(){return [...buffers.values()].some(buffer=>buffer.dirty);},
      get activeDirty(){return Boolean(active?.dirty);},getText:()=>active?.doc.getValue()||'',
      getState:state,
      destroy(){destroyed=true;navigation?.destroy();observer.disconnect();newWindow.destroy();keysWindow.destroy();for(const item of [...searchWindows])item.close();for(const buffer of buffers.values())buffer.doc.off('change',buffer.onChange);host.replaceChildren();},
    };
    navigation=window.WorkbenchCppNavigation?.create(api,{host,onNotice});
    api.navigation=navigation;
    return api;
  }
  window.WorkbenchEditor={create,contentHash};
})();
