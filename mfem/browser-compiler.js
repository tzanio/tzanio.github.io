/* Terminal bridge for the optional worker compiler. Loaded only on command. */
'use strict';
(function(){
  function mount({rpc,readFile,upload,notice}){
    let worker,active=null;const queue=[];
    const asset=name=>name+(window.WorkbenchAssets?.[name]?'?v='+WorkbenchAssets[name]:'');
    async function finish(message){
      if(!active||message.job!==active.job)return;
      const task=active;let path;
      if(task.finishing)return;task.finishing=true;
      try{
        if(message.result){task.activity.update({stage:'install',label:'Returning executable to Linux…'});path=await upload(message.result)}
        if(active!==task)return;
        await rpc('browser-build-finish',{job:task.job,upload:path,error:message.error,log:message.log,timings:message.timings});path=null;
        if(active!==task)return;
        if(message.error)task.activity.fail(new Error(message.error));else task.activity.complete('Browser compilation finished');
      }catch(error){
        if(active===task){
          task.activity.fail(error);notice(error.message);
          // Upload/ELF-validation failures must release the terminal waiter too.
          // An error-only completion installs nothing and preserves its ELF.
          try{await rpc('browser-build-finish',{job:task.job,error:'Browser compiler hand-off failed: '+error.message,log:message.log||''})}
          catch{if(active===task)notice(error.message+'. Press Ctrl-C in the terminal to stop this build.')}
        }
      }
      finally{if(path)rpc('unlink',{path}).catch(()=>{});if(active===task){active=null;next()}}
    }
    function createWorker(){
      const instance=worker=new Worker(asset('browser-compiler-worker.js'));
      instance.onmessage=event=>{if(worker!==instance)return;const message=event.data;if(message.kind==='progress')active?.activity.update(message);else finish(message)};
      instance.onerror=event=>{if(worker!==instance)return;const job=active?.job;instance.terminate();worker=null;if(job)finish({job,error:event.message||'Browser compiler stopped (possibly memory pressure). Use mfem-build or retry.',log:''})};
    }
    async function next(){
      if(active||!queue.length)return;const task=active=queue.shift();
      try{task.activity=WorkbenchOperations.start('Browser build',{label:'Reading current compiler inputs…'});const bytes=await readFile(task.path);if(active!==task)return;if(!worker)createWorker();worker.postMessage({kind:'build',job:task.job,input:bytes,assets:window.WorkbenchAssets||{}},[bytes.buffer])}
      catch(error){finish({job:task.job,error:error.message,log:''})}
    }
    function handle(message){
      if(message.event==='browser-build'){queue.push(message);next()}
      if(message.event==='browser-build-cancel'){
        if(active?.job===message.job){worker?.terminate();worker=null;active.activity.fail(new Error('Cancelled from terminal'));active=null;next()}
        else{const index=queue.findIndex(task=>task.job===message.job);if(index>=0)queue.splice(index,1)}
      }
    }
    return {handle,get busy(){return!!active},destroy(){worker?.terminate()}};
  }
  window.WorkbenchBrowserCompiler={mount};
})();
