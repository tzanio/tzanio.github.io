/* Progress for local work. Unknown work stays indeterminate; closing only hides it. */
'use strict';
(function () {
  const tasks=new Set();
  let panel,windowHandle,button,timer;
  const elapsed=ms=>{const seconds=Math.floor(ms/1000);return seconds<60?seconds+'s':Math.floor(seconds/60)+'m '+seconds%60+'s'};
  const amount=(value,unit)=>unit==='bytes'?(value/1048576).toFixed(1)+' MiB':Math.floor(value).toLocaleString()+' '+(unit||'items');
  function mount() {
    if(panel)return;
    panel=document.createElement('section');panel.id='operation-progress';
    panel.innerHTML='<div class="operation-list"></div><p class="operation-hint">Closing this window keeps the work running.</p>';
    document.body.append(panel);
    button=document.createElement('button');button.id='activity-toggle';button.type='button';button.hidden=true;
    document.querySelector('header nav').append(button);
    windowHandle=WorkbenchWindows.attach(panel,{title:'Activity',width:360,anchor:document.getElementById('backup')});
    button.onclick=()=>windowHandle.toggle();
  }
  function renderTask(task) {
    const {row,state}=task,active=state==='running',known=Number.isFinite(task.total)&&task.total>0;
    row.dataset.state=state;row.dataset.stage=task.stage||'';
    row.querySelector('.operation-stage').textContent=task.label||'Working…';
    row.querySelector('.operation-detail').textContent=task.detail||'';
    const meter=row.querySelector('progress');meter.hidden=!active;
    if(known){meter.max=task.total;meter.value=Math.min(task.total,Math.max(0,task.completed||0))}
    else meter.removeAttribute('value');
    const parts=[];
    if(active&&known) {
      const done=Math.max(0,Math.min(task.total,task.completed||0));
      parts.push(Math.floor(done/task.total*100)+'%');
      parts.push(amount(done,task.unit)+' / '+amount(task.total,task.unit));
    } else if(active&&Number.isFinite(task.completed)&&task.completed>0)parts.push(amount(task.completed,task.unit));
    parts.push(elapsed((task.ended||performance.now())-task.started));
    row.querySelector('.operation-count').textContent=parts.join(' · ');
    row.querySelector('.operation-dismiss').hidden=active;
    row.setAttribute('aria-busy',String(active));
  }
  function render() {
    const active=[...tasks].filter(task=>task.state==='running').length;
    button.hidden=!tasks.size;button.dataset.active=String(active>0);
    button.textContent=active?'Activity · '+active:'Activity';
    button.setAttribute('aria-label',active+' operations running. Show activity');
    panel.querySelector('.operation-hint').hidden=!active;
    for(const task of tasks)renderTask(task);
    if(!tasks.size)windowHandle.close({restoreFocus:false});
    if(!active){clearInterval(timer);timer=null}
    else if(!timer)timer=setInterval(()=>{for(const task of tasks)renderTask(task)},1000);
  }
  function start(title,{label='Working…',detail='',delay=0}={}) {
    mount();
    const row=document.createElement('article');row.className='operation';
    row.innerHTML='<div class="operation-title"><strong></strong><button class="operation-dismiss" type="button" hidden>×</button></div><div class="operation-stage" role="status"></div><progress></progress><div class="operation-count"></div><div class="operation-detail"></div>';
    row.querySelector('strong').textContent=title;
    row.querySelector('progress').setAttribute('aria-label',title+' progress');
    row.querySelector('.operation-dismiss').setAttribute('aria-label','Dismiss '+title);
    const task={row,state:'running',label,detail,started:performance.now(),ended:null};
    let revealTimer,removeTimer,visible=false;
    function reveal() {
      if(visible||task.state!=='running')return;
      visible=true;tasks.add(task);panel.querySelector('.operation-list').append(row);render();windowHandle.open({focus:false});
    }
    function remove() {clearTimeout(removeTimer);tasks.delete(task);row.remove();render()}
    row.querySelector('.operation-dismiss').onclick=remove;
    delay?revealTimer=setTimeout(reveal,delay):reveal();
    return {
      update(values) {
        if(task.state!=='running')return;
        // Each stage has its own denominator; never carry a previous stage's 100% forward.
        if(values.stage!==undefined&&values.stage!==task.stage){task.total=null;task.completed=null;task.detail=''}
        Object.assign(task,values);if(visible)renderTask(task);
      },
      complete(message='Complete') {
        if(task.state!=='running')return;
        clearTimeout(revealTimer);task.state='complete';task.ended=performance.now();task.label=message;task.detail='';
        if(visible){render();removeTimer=setTimeout(remove,8000)}
      },
      fail(error) {
        if(task.state!=='running')return;
        clearTimeout(revealTimer);reveal();task.state='error';task.ended=performance.now();task.label='Could not finish';task.detail=error?.message||String(error);render();
        windowHandle.open({focus:false});
      },
    };
  }
  window.WorkbenchOperations={start};
})();
