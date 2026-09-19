/* Local Git review and portable reproductions. Nothing is submitted online. */
'use strict';
(function(){
  function mount({rpc,readFile,editor,terminal,notice,openFile,isReady,getCwd,getRuntime}) {
    const panel=document.createElement('section');panel.id='developer-tools';
    panel.innerHTML=`<div class="changes-toolbar"><button data-action="refresh">Refresh</button><button data-action="patch">Export changes</button><button data-action="bundle">Reproduction…</button></div>
      <p class="changes-summary" role="status">Open Changes after Linux is ready.</p>
      <div class="changes-content"><div class="changes-files" aria-label="Changed files"></div><pre class="changes-diff" tabindex="0" aria-label="Patch preview"></pre></div>
      <details class="reproduction-fields"><summary>Reproduction bundle</summary><label>Command<input name="command" placeholder="./ex1 -m ../data/star.mesh -o 2"></label><label>Mesh paths (one per line, relative to mfem)<textarea name="meshes" rows="2" placeholder="data/star.mesh"></textarea></label><label>Test selection / result<input name="tests" placeholder='[Vector] · passed'></label><label class="reproduction-log"><input type="checkbox" name="include-log" checked> Include terminal scrollback</label><button data-action="export-bundle">Create bundle</button><p>Includes a patch, base commit, command, selected meshes and terminal output. Review the files before sharing.</p></details>`;
    document.body.append(panel);
    const button=document.createElement('button');button.id='changes-toggle';button.textContent='Changes';document.querySelector('header nav').append(button);
    const handle=WorkbenchWindows.attach(panel,{title:'Changes',width:760,anchor:button});
    let busy=false,selected=null,revision=0;
    const summary=panel.querySelector('.changes-summary'),files=panel.querySelector('.changes-files'),diff=panel.querySelector('.changes-diff');
    const setBusy=value=>{busy=value;panel.querySelectorAll('.changes-toolbar button,[data-action="export-bundle"]').forEach(item=>item.disabled=value)};
    async function preview(path) {
      selected=path;const token=++revision;diff.textContent='Reading changes…';
      for(const row of files.children)row.classList.toggle('selected',row.dataset.path===path);
      try {const result=await rpc('changes-diff',path?{paths:[path]}:{});if(token!==revision)return;diff.textContent=result.text||'No working-tree difference from the shipped release.';if(result.truncated)diff.textContent+='\n\nPreview truncated. Export changes contains the full patch.'}
      catch(error){if(token===revision)diff.textContent=error.message}
    }
    async function refresh() {
      if(busy)return;if(!isReady()){summary.textContent='Wait for Linux to finish starting.';return}
      setBusy(true);summary.textContent='Reading Git status…';
      try {
        const result=await rpc('changes-status');files.replaceChildren();
        const committed=result.head!==result.base_commit;
        summary.textContent=result.branch+' · '+result.entries.length+' changed files'+(committed?' · includes local commits':'')+' · base '+result.base_commit.slice(0,12);
        const all=document.createElement('button');all.textContent='All changes';all.onclick=()=>preview(null);files.append(all);
        for(const entry of result.entries) {
          const row=document.createElement('div');row.className='changes-file';row.dataset.path=entry.path;
          const view=document.createElement('button');view.className='changes-file-name';view.textContent=entry.status+' '+(entry.from?entry.from+' → ':'')+entry.path;view.title=entry.path;view.onclick=()=>preview(entry.path);
          const edit=document.createElement('button');edit.textContent='↗';edit.title='Open in editor';edit.setAttribute('aria-label','Open '+entry.path+' in editor');edit.onclick=()=>openFile('/root/mfem/'+entry.path).catch(error=>notice(error.message));edit.disabled=entry.status.includes('D');
          row.append(view,edit);files.append(row);
        }
        await preview(selected&&result.entries.some(item=>item.path===selected)?selected:null);
      }catch(error){summary.textContent=error.message}finally{setBusy(false)}
    }
    function terminalLog(){const buffer=terminal.buffer.active,lines=[];for(let i=Math.max(0,buffer.length-3000);i<buffer.length;i++)lines.push(buffer.getLine(i)?.translateToString(true)||'');return lines.join('\n')}
    async function exportChanges(reproduction=false) {
      if(busy||!isReady())return;setBusy(true);
      const title=reproduction?'Export reproduction':'Export changes',activity=WorkbenchOperations.start(title,{label:'Saving editor changes…'});let path;
      try {
        if(!await editor.saveAll())throw new Error('Resolve editor conflicts before exporting.');
        const request=reproduction?{command:panel.querySelector('[name="command"]').value,cwd:getCwd(),meshes:panel.querySelector('[name="meshes"]').value.split('\n').map(path=>path.trim()).filter(Boolean),tests:panel.querySelector('[name="tests"]').value,log:panel.querySelector('[name="include-log"]').checked?terminalLog():'',runtime:getRuntime()}:{};
        const result=await rpc(reproduction?'reproduction-export':'changes-export',request,progress=>activity.update({...progress,label:progress.stage==='packing'?'Packing bundle…':'Comparing workspace with MFEM 4.10…'}));path=result.path;
        activity.update({stage:'download',label:'Preparing download…'});const bytes=await readFile(path);
        WorkbenchOperations.download(activity,bytes,(reproduction?'mfem-reproduction-':'mfem-changes-')+new Date().toISOString().slice(0,10)+'.tar.gz');
      }catch(error){activity.fail(error,{retry:()=>exportChanges(reproduction)});notice(error.message)}
      finally{if(path)rpc('unlink',{path}).catch(()=>{});setBusy(false)}
    }
    button.onclick=()=>{handle.toggle();if(!panel.hidden)refresh()};
    panel.querySelector('[data-action="refresh"]').onclick=refresh;
    panel.querySelector('[data-action="patch"]').onclick=()=>exportChanges(false);
    panel.querySelector('[data-action="bundle"]').onclick=()=>{const fields=panel.querySelector('details');fields.open=!fields.open;if(fields.open)fields.querySelector('input').focus()};
    panel.querySelector('[data-action="export-bundle"]').onclick=()=>exportChanges(true);
    return {open:()=>{handle.open();return refresh()},refresh,exportChanges};
  }
  window.WorkbenchDeveloperTools={mount};
})();
