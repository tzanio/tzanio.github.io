/* Native compute uses the same UI served by the explicit local companion. */
'use strict';
(function(){
  const command='python3.12 companion/serve.py --workspace /path/to/mfem';
  function mount({runtime,notice=()=>{}}={}){
    const local=runtime?.mode==='local';
    const button=document.createElement('button');button.id='compute-open';button.type='button';button.textContent='Compute';button.setAttribute('aria-expanded','false');
    button.title=local?'Using native local compute':'Browser compute and native local compute';
    document.querySelector('header nav').append(button);
    const panel=document.createElement('section');panel.id='compute-window';
    const content=document.createElement('div');panel.append(content);
    const floating=WorkbenchWindows.attach(panel,{title:'Compute',width:490,anchor:button,onClose:()=>button.setAttribute('aria-expanded','false')});
    const paragraph=(text,className)=>{const p=document.createElement('p');p.textContent=text;if(className)p.className=className;content.append(p);return p};
    function render(){
      content.replaceChildren();
      if(local){
        const info=runtime.info||{},platform=/darwin|mac/i.test(info.platform||'')?'macOS':/linux/i.test(info.platform||'')?'Linux':info.platform||'this computer';
        paragraph('Native compute · '+platform,'compute-mode');
        paragraph(info.workspace||'Connecting to your local checkout…','compute-workspace');
        paragraph('The editor and terminal use this checkout. Compilation and simulations run in the companion process on your computer; GLVis stays in this browser.');
        paragraph('Terminal commands run as your local account and can change files available to that account.');
        paragraph('Keep the companion running. Closing this page leaves its terminal and jobs running. Reload this page to reconnect.');
        const link=document.createElement('a');link.href='https://tzanio.github.io/mfem/';link.target='_blank';link.rel='noopener';link.textContent='Open browser-only version';content.append(link);
      }else{
        paragraph('Browser compute','compute-mode');
        paragraph('MFEM runs in the browser on this device. For native builds on a laptop or desktop, use the same editor, terminal and GLVis with the local companion.');
        const download=document.createElement('a');download.href='downloads/mfem-local.zip';download.download='mfem-local.zip';download.textContent='Download local companion';content.append(download);
        paragraph('Requires Python 3.12 or newer, Bash, Make, a C++17 compiler, and a serial MFEM 4.10 checkout configured and built with Make. Its static libmfem.a is required for the visualization helpers.');
        paragraph('From the unpacked distribution, run:');
        const pre=document.createElement('pre');pre.className='compute-command';const code=document.createElement('code');code.textContent=command;pre.append(code);content.append(pre);
        const copy=document.createElement('button');copy.type='button';copy.textContent='Copy command';
        copy.onclick=async()=>{
          try{await navigator.clipboard.writeText(command);notice('Local compute command copied. Replace /path/to/mfem with your checkout.');}
          catch{const selection=getSelection(),range=document.createRange();range.selectNodeContents(code);selection.removeAllRanges();selection.addRange(range);notice('Command selected. Copy it and replace /path/to/mfem with your checkout.');}
        };content.append(copy);
        paragraph('Replace /path/to/mfem with your MFEM checkout. Open the localhost URL printed by the companion and keep that process running while you work.');
        paragraph('The browser-only version remains available on phones and tablets.');
      }
    }
    function open(){floating.open();button.setAttribute('aria-expanded','true')}
    button.onclick=()=>{if(floating.isOpen)floating.close();else open()};render();
    if(local&&runtime.ready?.then)runtime.ready.then(render).catch(error=>{paragraph('Local compute could not connect: '+error.message,'compute-error')});
    return {open,update:render,element:panel,destroy(){floating.destroy();button.remove()}};
  }
  window.WorkbenchCompute={mount};
})();
