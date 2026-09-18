(function () {
  'use strict';
  const base = new URL('.', document.currentScript.dataset.source || document.currentScript.src);
  const format = bytes => (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MiB';
  let registration;
  async function connect() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) {
      throw new Error('Offline downloads need HTTPS or localhost and service worker support.');
    }
    if (!registration) registration = navigator.serviceWorker.register(new URL('service-worker.js', base), {scope: base.pathname});
    const registered = await registration;
    if (!registered.active) await navigator.serviceWorker.ready;
    return registered.active || (await navigator.serviceWorker.ready).active;
  }
  async function request(type, onProgress) {
    const worker = await connect();
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = event => {
        const message = event.data;
        if (message.type === 'progress') {onProgress?.(message); return;}
        channel.port1.close();
        if (message.type === 'error') {
          const error = new Error(message.error); error.cancelled = message.cancelled; reject(error);
        } else resolve(message.state || message.value);
      };
      worker.postMessage({type}, [channel.port2]);
    });
  }
  function mount({container = document.querySelector('header nav')} = {}) {
    const button = document.createElement('button'); button.id = 'offline-open'; button.textContent = 'Offline';
    button.title = 'Download the workstation for use without a connection';
    container.append(button);
    const dialog = document.createElement('dialog'); dialog.id = 'offline-dialog';
    dialog.setAttribute('aria-labelledby', 'offline-title');
    dialog.innerHTML = '<div class="offline-heading"><h2 id="offline-title">Take the workstation offline</h2><button id="offline-close" aria-label="Close offline downloads">Close ×</button></div>' +
      '<p>Download the tools, MFEM checkout, examples and GLVis to this browser. Keep this tab open until the download finishes.</p>' +
      '<p class="offline-cache-note">Tools you use are also cached automatically, up to 256 MiB. The complete download below enables offline use.</p>' +
      '<p class="offline-note">This saves the installed tools. Export your workspace to keep your edits and results.</p>' +
      '<p id="offline-storage"></p><progress id="offline-progress" max="1" value="0" hidden></progress>' +
      '<p id="offline-message" role="status">Checking availability…</p>' +
      '<div class="offline-actions"><button id="offline-download">Download for offline use</button><button id="offline-cancel" hidden>Cancel download</button><button id="offline-remove" hidden>Remove offline files</button></div>';
    document.body.append(dialog);
    const $ = id => dialog.querySelector('#offline-' + id);
    const floating = WorkbenchWindows.attach(dialog, {title:'Offline download',width:520,anchor:button,
      heading:dialog.querySelector('.offline-heading'),closeButton:$('close'),returnFocus:button});
    let downloading = false, currentState, release;
    const message = text => $('message').textContent = text;
    const setState = state => {
      currentState = state;
      button.textContent = state.ready ? 'Offline ready' : 'Offline';
      $('remove').hidden = false;
      $('remove').title = 'Remove the complete download and automatically cached tools';
      $('download').textContent = state.ready ? 'Check and update download' : 'Download for offline use';
    };
    async function inspect() {
      try {
        const [state, manifest, storage] = await Promise.all([
          request('status'), request('manifest'), navigator.storage?.estimate?.() || Promise.resolve({}),
        ]);
        release = manifest; setState(state);
        $('storage').textContent = format(manifest.total_bytes) + ' download · ' + manifest.assets.length.toLocaleString() + ' files' +
          (storage.quota ? ' · ' + format(Math.max(0, storage.quota - storage.usage)) + ' browser storage available' : '');
        message(state.ready ? (state.version === manifest.version ? 'This release is ready to use offline.' : 'An updated release is available. Your previous download is still saved.') :
          'The full download includes every file needed to boot, edit, build and run the included configuration.');
      } catch (error) {message(error.message);}
    }
    button.addEventListener('click', () => {floating.open(); if (!downloading) inspect();});
    $('cancel').addEventListener('click', async () => {
      $('cancel').disabled = true;
      try {await request('cancel');} catch (error) {message(error.message);}
    });
    $('remove').addEventListener('click', async () => {
      try {setState(await request('remove')); message('Offline files and cached tools removed. Exported workspace downloads are unchanged.');}
      catch (error) {message(error.message);}
    });
    $('download').addEventListener('click', async () => {
      if (downloading) return;
      downloading = true; $('download').disabled = true; $('remove').disabled = true;
      $('cancel').hidden = false; $('cancel').disabled = false; $('progress').hidden = false;
      message('Preparing the offline download…');
      try {
        const state = await request('download', progress => {
          $('progress').max = progress.total_bytes || 1; $('progress').value = progress.bytes;
          message(format(progress.bytes) + ' / ' + format(progress.total_bytes) + ' · ' +
            progress.completed.toLocaleString() + ' / ' + progress.files.toLocaleString() + ' files');
        });
        setState(state); message('Ready for offline use. Your edits and results still need workspace export.');
      } catch (error) {
        message(error.cancelled ? 'Download cancelled. Download again to resume the saved files.' : error.message + ' You can retry the download.');
      } finally {
        downloading = false; $('download').disabled = false; $('remove').disabled = false;
        $('cancel').hidden = true;
      }
    });
    request('status').then(setState).catch(() => {});
    return {button, dialog, inspect, get state() {return currentState;}, get release() {return release;},
      destroy() {floating.destroy();button.remove();}};
  }
  window.WorkbenchOffline = {mount, request};
})();
