/* Native compute uses the same UI served by the explicit local companion. */
'use strict';
(function(){
  const command='python3.12 companion/serve.py --workspace /path/to/mfem';
  function mount({runtime,notice=()=>{}}={}){
    const local=runtime?.mode==='local';
    const button=document.createElement('button');button.id='compute-open';button.type='button';button.textContent=local?'Compute':'Local compute';button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls','compute-window');
    button.title=local?'Using native local compute':'Use your computer’s compiler with this browser interface';
    document.querySelector('header nav').append(button);
    const panel=document.createElement('section');panel.id='compute-window';
    const content=document.createElement('div');panel.append(content);
    const floating=WorkbenchWindows.attach(panel,{title:local?'Compute':'Local compute',width:520,anchor:button,onClose:()=>button.setAttribute('aria-expanded','false')});
    const paragraph=(text,className,parent=content)=>{const p=document.createElement('p');p.textContent=text;if(className)p.className=className;parent.append(p);return p};
    const link=(text,href,parent=content)=>{const a=document.createElement('a');a.href=href;a.textContent=text;parent.append(a);return a};
    function instructions(parent){
      const pre=document.createElement('pre');pre.className='compute-command';const code=document.createElement('code');code.textContent=command;pre.append(code);parent.append(pre);
      const copy=document.createElement('button');copy.type='button';copy.textContent='Copy launch command';
      copy.onclick=async()=>{
        try{await navigator.clipboard.writeText(command);notice('Local compute command copied. Replace /path/to/mfem with your checkout.');}
        catch{const selection=getSelection(),range=document.createRange();range.selectNodeContents(code);selection.removeAllRanges();selection.addRange(range);notice('Command selected. Copy it and replace /path/to/mfem with your checkout.');}
      };parent.append(copy);
    }
    function render(){
      content.replaceChildren();
      if(local){
        const info=runtime.info||{},platform=/darwin|mac/i.test(info.platform||'')?'macOS':/linux/i.test(info.platform||'')?'Linux':info.platform||'this computer';
        paragraph('Native compute · '+platform,'compute-mode');
        paragraph(info.workspace||'Connecting to your local checkout…','compute-workspace');
        paragraph('The editor and terminal use this checkout. Compilation and simulations run in the companion process on your computer; GLVis stays in this browser.');
        paragraph('Build and run in the Terminal pane. No separate xterm, X11 server or DISPLAY setting is needed.');
        if(info.capabilities?.mpi){
          paragraph('MPI checkout: build with make ex1p, then run mpirun -np 2 ./ex1p in the Terminal pane. Parallel mesh/solution visualization supports up to 64 ranks and one visualizing MPI job at a time.');
        }
        paragraph('Terminal commands run as your local account and can change files available to that account.');
        paragraph('Keep the companion running. Closing this page leaves its terminal and jobs running. Reload this page to reconnect.');
        const browser=link('Open browser-only version','https://tzanio.github.io/mfem/');browser.target='_blank';browser.rel='noopener';
      }else{
        paragraph('Use your laptop or desktop compiler','compute-mode');
        paragraph('Keep this Files, Editor, Terminal and GLVis interface. A small local companion runs builds and simulations directly on your computer.');
        paragraph('Requires Python 3.12 or newer, Bash, Make, a C++17 compiler, and a serial or MPI MFEM 4.10 checkout configured and built with Make. Its static libmfem.a is required for the visualization helpers. MPI checkouts also need their usual MPI and solver dependencies.');
        const steps=document.createElement('ol');steps.className='compute-steps';content.append(steps);
        const step=title=>{const li=document.createElement('li'),label=document.createElement('strong');label.textContent=title;li.append(label);steps.append(li);return li};
        const download=link('Download local companion','downloads/mfem-local.zip',step('Download. '));download.download='mfem-local.zip';
        paragraph('Unzip the download. Open your computer’s terminal and change into the extracted folder containing companion/ and site/.',null,step('Extract.'));
        const launch=step('Launch.');paragraph('Replace /path/to/mfem with the absolute path to your native MFEM checkout, then run:',null,launch);instructions(launch);
        paragraph('Open the localhost link printed by the companion. Use that page’s Terminal pane for make ex1 and ./ex1. GLVis displays the result in the browser; no separate xterm, X11 server or DISPLAY setting is needed.',null,step('Open and work.'));
        paragraph('Keep the companion process running while you work. Starting it is a one-time manual step for each session; this website cannot launch it for you.');
        paragraph('To move your current work, choose Export → Save & export changes here, then Import in the local page. Choose Full workspace to include layout, tabs, terminal output and displayed GLVis data. Native files save directly to your checkout. Rebuild imported code on the destination.');
        const guide=link('Setup details and a fresh MFEM checkout','guide.html#local-compute');guide.target='_blank';guide.rel='noopener';
        paragraph('Local compute is for a laptop or desktop. Phones and tablets can continue using browser-only compute.');
      }
    }
    function open(){floating.open();button.setAttribute('aria-expanded','true')}
    button.onclick=()=>{if(floating.isOpen)floating.close();else open()};render();
    if(local&&runtime.ready?.then)runtime.ready.then(render).catch(error=>{paragraph('Local compute could not connect: '+error.message,'compute-error')});
    return {open,update:render,element:panel,destroy(){floating.destroy();button.remove()}};
  }
  window.WorkbenchCompute={mount};
})();
