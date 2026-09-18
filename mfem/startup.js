/* Show startup before the large application scripts arrive. No synthetic timers. */
(function () {
  'use strict';
  const base = new URL('.', document.currentScript.src);
  const panel = document.getElementById('startup-progress');
  const heading = document.getElementById('startup-heading');
  const detail = document.getElementById('startup-detail');
  const meter = document.getElementById('startup-meter');
  const retry = document.getElementById('startup-retry');
  const files = new Map();
  let inventory = false, inventoryUnavailable = false, linux = false, visual = false, finished = false, fatalFailure = '', lastChange = performance.now();
  let renderTimer;
  const mb = bytes => (bytes / 1e6).toFixed(1);
  function relative(value) {
    try {
      const url = new URL(value, base);
      return url.origin === base.origin && url.pathname.startsWith(base.pathname) ? url.pathname.slice(base.pathname.length) : null;
    } catch {return null}
  }
  function file(url) {
    const name = relative(url);
    if (!name || name === 'index.html' || /^(startup-downloads\.json|offline-manifest\.json|service-worker\.js)$/.test(name)) return null;
    if (!files.has(name)) files.set(name, {url:name,bytes:0,loaded:0,total:0,done:false,active:false});
    return files.get(name);
  }
  function totals() {
    let total = 0, loaded = 0, active = 0;
    for (const entry of files.values()) {
      const size = entry.bytes || entry.total;
      total += size;
      loaded += entry.done ? size : entry.total && size ? size * Math.min(1,entry.loaded / entry.total) : Math.min(size,entry.loaded);
      active += Number(entry.active);
    }
    return {total,loaded,active};
  }
  const failure = () => fatalFailure || [...files.values()].find(entry=>entry.error)?.error || '';
  function render() {
    clearTimeout(renderTimer);renderTimer = null;
    if (finished) return;
    const {total,loaded,active} = totals();
    const problem = failure();
    const remaining = Math.max(0,total-loaded);
    const elapsed = Math.floor(performance.now()/1000);
    const time = elapsed < 60 ? elapsed+'s' : Math.floor(elapsed/60)+'m '+elapsed%60+'s';
    heading.textContent = problem ? 'Startup needs attention' : linux ? 'Linux ready · running ./ex1' : 'Starting Linux';
    retry.hidden = !problem;
    panel.dataset.state = problem ? 'error' : 'loading';
    if (inventory && total) {
      meter.value = 100 * loaded / total;
      meter.setAttribute('aria-valuetext',`${mb(loaded)} of about ${mb(total)} MB of startup files ready`);
      detail.textContent = problem || (remaining > 50000 ? `${mb(loaded)} / ~${mb(total)} MB ready · ~${mb(remaining)} MB left` : linux ? 'Downloads ready · preparing GLVis' : 'Downloads ready · booting Linux');
    } else {
      meter.removeAttribute('value');meter.removeAttribute('aria-valuetext');
      detail.textContent = problem || (loaded ? mb(loaded)+' MB ready · '+(inventoryUnavailable ? 'total size unavailable' : 'calculating remaining download') : 'Downloading startup files…');
    }
    if (!problem && elapsed >= 5) detail.textContent += ' · '+time;
    if (!problem && active && performance.now()-lastChange > 15000) detail.textContent += ' · waiting for network';
  }
  function schedule() {if (!renderTimer && !finished) renderTimer=setTimeout(render,100)}
  function progress(event) {
    if (finished) return;
    const entry = file(event.url);if (!entry) return;
    if (event.error) {
      // v86 retries transient failures itself; keep the status visible meanwhile.
      if(!entry.done)entry.error = 'Could not download '+(entry.url.startsWith('vm/') ? 'a Linux file' : entry.url.split('/').pop())+'. Check your connection or reload.';
      entry.active=false;entry.loaded=0;entry.total=0;
    } else {
      if (event.loaded > entry.loaded || event.done) lastChange=performance.now();
      if(event.done)entry.error='';
      entry.loaded=Math.max(entry.loaded,Number(event.loaded)||0);
      if (event.lengthComputable && event.total>0) entry.total=event.total;
      entry.done ||= !!event.done;entry.active=!entry.done;
    }
    schedule();
  }
  function error(message) {fatalFailure=message;schedule()}
  function complete() {
    if (finished || !linux || !visual) return;
    finished=true;clearTimeout(renderTimer);clearInterval(tick);
    observer?.disconnect();window.removeEventListener('error',scriptError);window.WorkbenchDownloadMonitor?.stop();
    window.workstation?.vm.finishDownloads?.();
    panel.dataset.state='ready';heading.textContent='Ready';
    detail.textContent='Linux and GLVis are ready';meter.value=100;retry.hidden=true;
    meter.setAttribute('aria-valuetext','Startup complete');
    setTimeout(()=>{panel.hidden=true},1800);
  }
  window.WorkbenchStartup={progress,error,
    linuxReady(){linux=true;schedule();complete()},
    visualReady(){visual=true;complete()},
    snapshot(){return {...totals(),inventory,linux,visual,finished,failure:failure()}},
  };
  retry.onclick=()=>location.reload();
  window.WorkbenchDownloadMonitor?.install(progress);
  // Native CSS, font, fetch, and worker-script requests also contribute once
  // available. Entries are deduplicated with streamed XHR progress by URL path.
  let observer;
  try {
    observer=new PerformanceObserver(list=>{
      for (const entry of list.getEntries()) {
        // Optional bulk offline downloads and files the user opens are not
        // prerequisites for startup. Worker requests still register real new
        // guest dependencies through the explicit progress channel.
        if(inventory && entry.initiatorType==='fetch' && !files.has(relative(entry.name)))continue;
        const item=file(entry.name);
        if (item && entry.responseEnd>0) {
          // XHR errors have a ResourceTiming entry too; their own status wins.
          if (entry.initiatorType==='xmlhttprequest') continue;
          if(entry.responseStatus>=400){progress({url:entry.name,error:true,status:entry.responseStatus});continue}
          if (!item.bytes && entry.decodedBodySize) item.bytes=entry.decodedBodySize;
          progress({url:entry.name,done:true});
        }
      }
    });
    observer.observe({type:'resource',buffered:true});
  } catch {/* Byte progress for the main downloads does not require this API. */}
  const tick=setInterval(render,1000);
  function scriptError(event){if(!finished && event.message)error('Could not start the workstation: '+event.message+'. Reload to try again.')}
  window.addEventListener('error',scriptError);
  const asset=name=>{const url=new URL(name,base);if(window.WorkbenchAssets?.[name])url.searchParams.set('v',WorkbenchAssets[name]);return url.href};
  fetch(asset('startup-downloads.json')).then(response=>{
    if(!response.ok)throw new Error('Startup size unavailable');return response.json();
  }).then(manifest=>{
    if(manifest.schema!==1 || !Array.isArray(manifest.assets))throw new Error('Unsupported startup inventory');
    for(const asset of manifest.assets){const entry=file(asset.url);if(entry && asset.bytes>=0)entry.bytes=asset.bytes}
    inventory=true;schedule();
  }).catch(()=>{inventoryUnavailable=true;schedule()});
  function source(url) {
    return new Promise((resolve,reject)=>{
      const request=new XMLHttpRequest();request.open('GET',url);request.responseType='text';
      request.onload=()=>request.status>=200 && request.status<300 ? resolve(request.responseText) : reject(new Error('Could not download '+relative(url)+' (HTTP '+request.status+'). Check your connection and reload.'));
      request.onerror=()=>reject(new Error('Could not download '+relative(url)+'. Check your connection and reload.'));
      request.onabort=()=>reject(new Error('Startup download cancelled. Reload to try again.'));
      request.send();
    });
  }
  async function load() {
    const scripts=[...document.querySelectorAll('script[type="application/x-workbench"]')]
      .filter(script=>!script.dataset.mainOnly || new URLSearchParams(location.search).get('runtime')==='main');
    // Fetch concurrently, then execute in dependency order. Original URLs are
    // retained for relative assets, diagnostics and source-map tooling.
    const pending=scripts.map(script=>{
      const url=new URL(script.dataset.src,base).href;
      const promise=source(url);promise.catch(()=>{});return {url,promise};
    });
    for(const item of pending) {
      const script=document.createElement('script');script.dataset.source=item.url;
      script.textContent=(await item.promise)+'\n//# sourceURL='+item.url+'\n';
      document.body.append(script);
      script.remove();item.promise=null;
    }
  }
  load().catch(cause=>error(cause.message));
  render();
})();
