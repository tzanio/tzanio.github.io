/* On-demand native MFEM inspection of the frame actually displayed by a view. */
'use strict';
(function () {
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const format = value => Number.isFinite(value) ? Number(value.toPrecision(6)).toString() : '—';
  const attributeColor = attribute => `hsl(${((Number(attribute) * 137.508) % 360 + 360) % 360} 72% 65%)`;
  function attach({button, visual, rpc, readFile, upload, getFrame, suffix = ''}) {
    const panel = document.createElement('section');panel.className = 'mesh-inspector';
    panel.innerHTML = `<div class="inspect-top"><span class="inspect-frame">No snapshot</span><button class="inspect-refresh">Refresh</button></div>
      <p class="inspect-status" role="status">Inspecting the displayed mesh…</p>
      <div class="inspect-content" hidden>
        <dl class="inspect-summary"></dl>
        <div class="inspect-attributes"><div><b>Element attributes</b><span class="inspect-element-attributes"></span></div><div><b>Boundary attributes</b><span class="inspect-boundary-attributes"></span></div></div>
        <p class="inspect-quality"></p><details><summary>Quality metric</summary><p>The smallest/largest singular-value ratio of MFEM’s perfect-element Jacobian. 1 is ideal; 0 is degenerate. Each element uses its worst value among its center and order-2 quadrature points. This sampling does not prove that a curved element is valid everywhere.</p></details>
        <div class="inspect-preview-tools"><label>Color <select class="inspect-color"><option value="quality">Element quality</option><option value="attribute">Element attribute</option></select></label><label>Boundary <select class="inspect-boundary"><option value="">All attributes</option></select></label></div>
        <canvas class="inspect-canvas" width="680" height="440" aria-label="XY mesh preview: click to probe solution values"></canvas>
        <p class="inspect-preview-note"></p>
        <form class="inspect-probe"><div class="inspect-coordinates"></div><button type="submit">Probe point</button></form>
        <p class="inspect-probe-result" role="status">Click the XY preview or enter physical coordinates.</p>
        <p class="inspect-field"></p>
      </div>`;
    document.body.append(panel);
    const get = selector => panel.querySelector(selector);
    const status = get('.inspect-status'), content = get('.inspect-content');
    const refreshButton = get('.inspect-refresh'), canvas = get('canvas');
    const probeForm = get('.inspect-probe'), result = get('.inspect-probe-result');
    const inspectorWindow = WorkbenchWindows.attach(panel,{title:'Mesh inspector' + suffix,width:510,anchor:button,returnFocus:visual});
    const abort = new AbortController();
    let snapshot = null, report = null, busy = false, destroyed = false, selected = null, viewport = null;
    function listen(element,name,callback) {element.addEventListener(name,callback,{signal:abort.signal})}
    function setBusy(value) {
      busy = value;refreshButton.disabled = value;
      probeForm.querySelector('button').disabled = value;
      panel.setAttribute('aria-busy',String(value));
    }
    async function discard(path) {if(path)try {await rpc('unlink',{path})} catch {}}
    async function request(path, point) {
      const resultPath = await rpc('mesh-inspect',{path,...(point ? {point} : {})});
      try {return JSON.parse(decoder.decode(await readFile(resultPath)))}
      finally {await discard(resultPath)}
    }
    function attributes(target,items) {
      target.replaceChildren();
      for (const [attribute,count] of items) {
        const item = document.createElement('span');item.className = 'inspect-attribute';
        const swatch = document.createElement('i');swatch.style.background = attributeColor(attribute);
        item.append(swatch,document.createTextNode(attribute + ': ' + count.toLocaleString()));target.append(item);
      }
      if(!items.length)target.textContent = 'None';
    }
    function draw() {
      if(!report)return;
      const ctx = canvas.getContext('2d'), width = canvas.width, height = canvas.height;
      const style = getComputedStyle(panel), [lo,hi] = report.bounds;
      ctx.fillStyle = style.getPropertyValue('--wb-input').trim() || '#101923';ctx.fillRect(0,0,width,height);
      let [x0,y0=0] = lo, [x1,y1=0] = hi;
      if(x0===x1){x0-=.5;x1+=.5}if(y0===y1){y0-=.5;y1+=.5}
      const scale = Math.min((width-40)/(x1-x0),(height-40)/(y1-y0));
      viewport = {x0:(x0+x1)/2-width/(2*scale),y0:(y0+y1)/2-height/(2*scale),scale};
      const project = ([x,y=0]) => [(x-viewport.x0)*scale,height-(y-viewport.y0)*scale];
      function line(points,color,lineWidth=1) {
        ctx.beginPath();points.forEach((point,index)=>{const p=project(point);index?ctx.lineTo(...p):ctx.moveTo(...p)});
        ctx.strokeStyle=color;ctx.lineWidth=lineWidth;ctx.stroke();
      }
      const mode=get('.inspect-color').value;
      for(const [element,attribute,quality,points] of report.preview) {
        const color=mode==='attribute'?attributeColor(attribute):`hsl(${Math.max(0,Math.min(1,quality))*125} 72% 63%)`;
        line(points,element===selected?.element?'#fff':color,element===selected?.element?3:1);
      }
      const boundary=get('.inspect-boundary').value;
      for(const [,attribute,points] of report.boundaryPreview) {
        if(boundary!=='' && Number(boundary)!==attribute)continue;
        line(points,attributeColor(attribute),boundary!==''?3:1.6);
      }
      if(selected?.point) {
        const [x,y]=project(selected.point);ctx.strokeStyle=style.getPropertyValue('--wb-text').trim() || '#fff';ctx.lineWidth=2;
        ctx.beginPath();ctx.moveTo(x-6,y);ctx.lineTo(x+6,y);ctx.moveTo(x,y-6);ctx.lineTo(x,y+6);ctx.stroke();
      }
    }
    function showReport(data,frame) {
      report = data;selected=null;content.hidden=false;
      const summary=get('.inspect-summary');summary.replaceChildren();
      for(const [name,value] of [['Mesh',data.dimension+'D in '+data.spaceDimension+'D'],['Elements',data.elements.toLocaleString()],['Vertices',data.vertices.toLocaleString()],['Boundary elements',data.boundaryElements.toLocaleString()]]) {
        const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=value;summary.append(dt,dd);
      }
      attributes(get('.inspect-element-attributes'),data.elementAttributes);
      attributes(get('.inspect-boundary-attributes'),data.boundaryAttributes);
      const boundary=get('.inspect-boundary');boundary.replaceChildren(new Option('All attributes',''));
      for(const [attribute] of data.boundaryAttributes)boundary.append(new Option('Attribute '+attribute,attribute));
      const q=data.quality;
      get('.inspect-quality').textContent=`Quality: min ${format(q.min)} · mean ${format(q.mean)} · max ${format(q.max)}. Worst element: ${q.worstElement}. Nonpositive sampled Jacobian: ${q.nonpositive} elements.`;
      get('.inspect-frame').textContent=`Frame ${frame.frame} snapshot`;
      get('.inspect-frame').title='This is the displayed frame captured when you opened or refreshed the inspector.';
      status.textContent='Native MFEM inspection · Refresh captures the latest displayed frame.';
      const truncated=data.previewStride>1 || data.boundaryPreviewStride>1;
      get('.inspect-preview-note').textContent='XY preview'+(data.spaceDimension===3?' — projection; choose Z below for the probe plane.':'.')+
        (truncated?' Preview thinned for size; statistics cover every element.':'')+' Curved edges are sampled. This preview is independent of the GLVis camera.';
      const coords=get('.inspect-coordinates');coords.replaceChildren();
      for(let index=0;index<data.spaceDimension;index++) {
        const label=document.createElement('label'),input=document.createElement('input');label.textContent='XYZ'[index];
        input.type='number';input.step='any';input.required=true;input.setAttribute('aria-label','Probe '+'XYZ'[index]);
        input.value=format((data.bounds[0][index]+data.bounds[1][index])/2);label.append(input);coords.append(label);
      }
      result.textContent='Click the XY preview or enter physical coordinates.';
      get('.inspect-field').textContent=data.field.unsupported || `${data.field.collection} · ${data.field.components} component${data.field.components===1?'':'s'}. Values are evaluated by MFEM; at an element interface, the first containing element is used.`;
      draw();inspectorWindow.constrain();
    }
    async function refresh() {
      if(busy || destroyed)return;
      const frame=getFrame();if(!frame?.data){status.textContent='No rendered frame to inspect.';return}
      setBusy(true);status.textContent='Reading the displayed mesh with MFEM…';
      let path;
      try {
        path=await upload(encoder.encode(frame.data));
        const data=await request(path);
        if(destroyed){await discard(path);return}
        await discard(snapshot?.path);snapshot={path,frame:frame.frame};path=null;
        showReport(data,frame);
      } catch(error) {
        status.textContent=error.message || String(error);
        if(!report)content.hidden=true;
      } finally {await discard(path);if(!destroyed)setBusy(false)}
    }
    async function probe(point) {
      if(busy || !snapshot || destroyed)return;
      if(point.some(value=>!Number.isFinite(value))){result.textContent='Enter finite coordinates.';return}
      setBusy(true);result.textContent='Locating the point and evaluating the field with MFEM…';
      try {
        const data=await request(snapshot.path,point);if(destroyed)return;
        selected=data;draw();
        const where='('+point.map(format).join(', ')+')';
        result.textContent=data.found ? `${where} · element ${data.element}, attribute ${data.attribute}`+
          (data.values?` · value${data.values.length===1?'':'s'}: ${data.values.map(format).join(', ')}`:` · ${data.unsupported}`) :
          `${where}: no containing element found. Check the domain and, for a surface mesh, the surface coordinates.`;
      } catch(error) {result.textContent=error.message || String(error)}
      finally {if(!destroyed)setBusy(false)}
    }
    listen(button,'click',()=>{inspectorWindow.open();if(!snapshot)refresh()});
    listen(refreshButton,'click',refresh);
    listen(get('.inspect-color'),'change',draw);listen(get('.inspect-boundary'),'change',draw);
    listen(probeForm,'submit',event=>{event.preventDefault();probe([...probeForm.querySelectorAll('input')].map(input=>Number(input.value)))});
    listen(canvas,'click',event=>{
      if(!viewport || busy)return;
      const rect=canvas.getBoundingClientRect(),x=(event.clientX-rect.left)*canvas.width/rect.width,y=(event.clientY-rect.top)*canvas.height/rect.height;
      const inputs=[...probeForm.querySelectorAll('input')];
      inputs[0].value=String(viewport.x0+x/viewport.scale);
      if(inputs.length>1)inputs[1].value=String(viewport.y0+(canvas.height-y)/viewport.scale);
      probe(inputs.map(input=>Number(input.value)));
    });
    listen(window,'workbench-themechange',draw);
    return {element:panel,get snapshot(){return snapshot},get report(){return report},get selected(){return selected},refresh,probe,
      close(){inspectorWindow.close({restoreFocus:false})},
      destroy(){destroyed=true;abort.abort();inspectorWindow.destroy();discard(snapshot?.path);snapshot=null},
    };
  }
  window.MeshInspector={attach};
})();
