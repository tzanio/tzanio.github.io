/* Portable UI state. Terminal restoration writes display cells, never shell input. */
'use strict';
(function(){
  const encoder=new TextEncoder(),MAX_BYTES=32*1024*1024,MAX_TERMINAL=4*1024*1024;
  const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
  const path=value=>typeof value==='string'&&value.length<=4096&&
    (value==='/root/mfem'||value.startsWith('/root/mfem/'))&&!value.split('/').some(part=>part==='.'||part==='..')&&!/[\x00-\x1f\x7f]/.test(value);
  const flush=terminal=>new Promise(resolve=>terminal.write('',resolve));
  function style(cell){
    const codes=[0];
    for(const [method,code] of [['isBold',1],['isDim',2],['isItalic',3],['isUnderline',4],['isBlink',5],['isInverse',7],['isInvisible',8],['isStrikethrough',9],['isOverline',53]])if(cell[method]?.())codes.push(code);
    for(const [prefix,code] of [['Fg',38],['Bg',48]]){
      const color=cell['get'+prefix+'Color']();
      if(cell['is'+prefix+'RGB']())codes.push(code,2,(color>>16)&255,(color>>8)&255,color&255);
      else if(cell['is'+prefix+'Palette']())codes.push(code,5,color);
    }
    return '\x1b['+codes.join(';')+'m';
  }
  function screen(buffer){
    const lines=[],cell=buffer.getNullCell();let previous='';
    // Omit unused screen rows below the last content, but retain blank lines in
    // the transcript and the current prompt. Save only retained scrollback.
    let end=buffer.length-1;
    while(end>buffer.baseY+buffer.cursorY&&!buffer.getLine(end)?.translateToString(true))end--;
    for(let y=Math.max(0,end-5199);y<=end;y++){
      const line=buffer.getLine(y);if(!line)continue;
      let last=line.length-1;
      if(!buffer.getLine(y+1)?.isWrapped){
        while(last>=0){const c=line.getCell(last,cell);if(c&&(c.getChars()||!c.isBgDefault()))break;last--}
      }
      let output=y&&line.isWrapped?'':'\r\n';
      for(let x=0;x<=last;x++){
        const c=line.getCell(x,cell);if(!c||c.getWidth()===0)continue;
        const next=style(c);if(next!==previous){output+=next;previous=next}
        output+=(c.getChars()||' ').replace(/[\x00-\x1f\x7f-\x9f]/g,'');
      }
      lines.push(output);
    }
    return lines.join('').replace(/^\r\n/,'')+'\x1b[0m';
  }
  async function captureTerminal(terminal){
    await flush(terminal);
    let ansi=screen(terminal.buffer.normal);
    const alternate=terminal.buffer.active.type==='alternate';
    if(alternate)ansi+='\r\n\x1b[0m[Saved application screen]\r\n'+screen(terminal.buffer.active);
    if(encoder.encode(ansi).length>MAX_TERMINAL)throw new Error('Terminal history is too large to export (4 MiB). Clear some scrollback and retry.');
    return {version:1,ansi,cols:terminal.cols,rows:terminal.rows,alternate,scrollFromBottom:terminal.buffer.active.baseY-terminal.buffer.active.viewportY};
  }
  function validateTerminal(value){
    if(!plain(value)||value.version!==1||typeof value.ansi!=='string'||encoder.encode(value.ansi).length>MAX_TERMINAL)throw new Error('Invalid saved terminal output.');
    // Accept only text, line breaks, tabs and SGR color/style sequences. Never
    // replay OSC, clipboard, title, hyperlinks, device queries or shell hooks.
    if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value.ansi.replace(/\x1b\[[0-9;]{1,80}m/g,'')))throw new Error('Saved terminal contains unsupported control sequences.');
    return {...value,cols:Math.max(20,Math.min(500,Number(value.cols)||80)),rows:Math.max(5,Math.min(200,Number(value.rows)||24))};
  }
  async function restoreTerminal(terminal,state){
    state=validateTerminal(state);await flush(terminal);terminal.reset();
    await new Promise(resolve=>terminal.write(state.ansi+'\r\n\x1b[0;2m[Restored output. At the shell prompt, press Ctrl+C to clear current input and restore history/directory.]\x1b[0m\r\n',resolve));
    if(Number.isFinite(state.scrollFromBottom)&&state.scrollFromBottom>0)terminal.scrollLines(-Math.min(5200,state.scrollFromBottom));
  }
  function create({editor,layout,simulation,terminal,rpc,getFiles,restoreFiles,getCwd}){
    function validate(state){
      if(!plain(state)||state.format!=='mfem-workbench-session'||state.version!==1)throw new Error('Unsupported workspace session format.');
      if(encoder.encode(JSON.stringify(state)).length>MAX_BYTES)throw new Error('Saved session exceeds the 32 MiB limit.');
      if(!plain(state.files)||!Array.isArray(state.files.expanded)||state.files.expanded.length>2000||!state.files.expanded.every(path))throw new Error('Invalid saved file-tree state.');
      if(!plain(state.shell)||typeof state.shell.history!=='string'||state.shell.history.includes('\0')||encoder.encode(state.shell.history).length>1048576||!path(state.shell.cwd)||encoder.encode(state.shell.cwd).length>4096)throw new Error('Invalid saved shell history or directory.');
      if(!plain(state.layout))throw new Error('Invalid saved layout.');
      if(!WorkbenchThemes.themes.some(theme=>theme.id===state.theme))throw new Error('Unknown saved interface theme.');
      editor.validateSession(state.editor);simulation.validateSession(state.visualization);validateTerminal(state.terminal);
      if(state.windows!==undefined){
        if(!Array.isArray(state.windows)||state.windows.length>100||state.windows.some(item=>!plain(item)||typeof item.id!=='string'||item.id.length>200))throw new Error('Invalid saved dialog state.');
        WorkbenchWindows.validateSession?.(state.windows);
      }
      return state;
    }
    async function capture(){
      await Promise.allSettled([...editor.buffers.values()].flatMap(buffer=>[buffer.saving,buffer.checking]).filter(Boolean));
      // A terminal edit or deletion may have happened since the last UI poll.
      // Refresh before deciding which open documents need retained drafts.
      await editor.checkExternal();
      const shell=await rpc('session-shell-capture');
      // The browser's OSC-7 value also covers an older prompt before the first
      // shell history flush. Limit cwd to the portable workspace.
      shell.cwd=path(shell.cwd)?shell.cwd:path(getCwd())?getCwd():'/root/mfem/examples';
      const state={format:'mfem-workbench-session',version:1,created:new Date().toISOString(),
        theme:WorkbenchThemes.current,layout:layout.exportSession(),files:getFiles(),
        editor:editor.exportSession(),terminal:await captureTerminal(terminal),shell,
        visualization:await simulation.exportSession(),windows:WorkbenchWindows.exportSession?.()};
      validate(state);
      const warnings=[];
      if(state.visualization.skippedViews)warnings.push('Some large GLVis datasets exceeded the session size limit and were omitted.');
      if(state.editor.warnings)warnings.push(...state.editor.warnings);
      return {bytes:encoder.encode(JSON.stringify(state)),warnings};
    }
    async function restore(state){
      validate(state);
      WorkbenchThemes.apply(state.theme);layout.restoreSession(state.layout);
      const warnings=await editor.restoreSession(state.editor,{preserveDirty:true});
      await restoreFiles(state.files);
      await simulation.restoreSession(state.visualization);
      await rpc('session-shell-restore',state.shell);
      await restoreTerminal(terminal,state.terminal);
      WorkbenchWindows.restoreSession?.(state.windows);
      return warnings||[];
    }
    return {capture,validate,restore};
  }
  window.WorkbenchSession={create,captureTerminal,validateTerminal,restoreTerminal};
})();
