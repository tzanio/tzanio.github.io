/* Track content mutations in v86's host filesystem, independently of guest
 * timestamp precision. This journal is only for workspace persistence. */
'use strict';
(function(scope){
  function install(fs,notify=()=>{}){
    if(!fs||!Array.isArray(fs.inodes)||typeof fs.Write!=='function'||typeof fs.ChangeSize!=='function')throw new Error('The Linux filesystem write journal is unavailable');
    const pending=new Map(),originals=new Map();let sequence=0,timer=null,closed=false,lastNotification=0;
    function snapshot(){
      const root=fs.SearchPath('root/mfem').id,writes=[];let busy=false;
      if(root<0)return {sequence,paths:[],writes,busy};
      const seen=new Set();
      function walk(id,prefix){
        const inode=fs.inodes[id];if(!inode)return;
        if((inode.mode&0o170000)===0o040000){
          if(seen.has(id))throw new Error('A workspace directory cycle prevents saving');seen.add(id);
          for(const [name,child] of inode.direntries)if(name!=='.'&&name!=='..')walk(child,prefix?prefix+'/'+name:name);
        }else if(pending.has(id)){
          const item=pending.get(id);writes.push({path:prefix,sequence:item.sequence});busy=busy||item.active>0;
        }
      }
      walk(root,'');return {sequence,paths:writes.map(item=>item.path),writes,busy};
    }
    function changed(id,active){
      const previous=pending.get(id);pending.set(id,{sequence:++sequence,active:(previous?.active||0)+active});
      if(!timer&&!closed)timer=setTimeout(()=>{
        timer=null;const current=snapshot(),latest=current.writes.reduce((value,item)=>Math.max(value,item.sequence),0);
        if(latest>lastNotification){lastNotification=latest;notify({sequence:latest})}
      },500);
    }
    for(const name of ['Write','ChangeSize']){
      const original=fs[name];originals.set(name,original);
      fs[name]=function(id,...args){
        changed(id,1);
        let result;try{result=original.call(this,id,...args)}catch(error){changed(id,-1);throw error}
        return Promise.resolve(result).finally(()=>changed(id,-1));
      };
    }
    function acknowledge(through){
      if(!Number.isSafeInteger(through)||through<0||through>sequence)throw new Error('Invalid filesystem journal acknowledgment');
      for(const [id,item] of pending)if(item.sequence<=through&&item.active===0)pending.delete(id);
      return snapshot();
    }
    return {snapshot,acknowledge,destroy(){closed=true;clearTimeout(timer);for(const [name,original] of originals)fs[name]=original;pending.clear()}};
  }
  scope.WorkbenchFilesystemJournal={install};
})(globalThis);
