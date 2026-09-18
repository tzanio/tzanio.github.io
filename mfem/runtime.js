/* The browser UI talks to the same VM API whether v86 runs in a worker or here. */
(function () {
  'use strict';
  const base = new URL('.', document.currentScript.src);
  const encoder = new TextEncoder();
  const asset = path => {
    const url = new URL(path, base);
    const relative = url.pathname.startsWith(base.pathname) ? url.pathname.slice(base.pathname.length) : '';
    if (window.WorkbenchAssets?.[relative]) url.searchParams.set('v', window.WorkbenchAssets[relative]);
    return url;
  };
  const lifecycle = ['emulator-ready', 'emulator-loaded', 'emulator-started',
    'emulator-stopped', 'download-progress', 'download-error'];
  function absoluteOptions(value, key) {
    if (typeof value === 'string' && ['url', 'wasm_path', 'baseurl'].includes(key)) {
      return asset(value).href;
    }
    if (Array.isArray(value)) return value.map(item => absoluteOptions(item));
    if (value && typeof value === 'object' && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, absoluteOptions(item, name)]));
    }
    return value;
  }
  function create(options) {
    const listeners = new Map(), pending = new Map(), input = new Map();
    let sequence = 0, destroyed = false, scheduled = false, worker, direct;
    const mode = new URLSearchParams(location.search).get('runtime') === 'main' ? 'main' : 'worker';
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => {resolveReady = resolve; rejectReady = reject;});
    // Report failures as events too; callers need not consume the ready promise.
    ready.catch(() => {});
    const emit = (name, value) => {
      for (const fn of [...(listeners.get(name) || [])]) fn(value);
      if (name === 'emulator-loaded') resolveReady();
      if (name === 'download-error') fail(new Error('Could not download a Linux asset: ' + (value?.file_name || 'unknown file')));
    };
    function fail(message) {
      const error = message instanceof Error ? message : new Error(String(message));
      rejectReady(error);
      for (const task of pending.values()) task.reject(error);
      pending.clear(); emit('runtime-error', error);
    }
    function serial(port, bytes) {
      emit('serial' + port + '-output-bytes', bytes);
      if (listeners.has('serial' + port + '-output-byte')) {
        for (const byte of bytes) emit('serial' + port + '-output-byte', byte);
      }
    }
    function flushInput() {
      scheduled = false;
      if (destroyed) return;
      for (const [port, chunks] of input) {
        const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
        if (worker) worker.postMessage({type: 'input', port, bytes}, [bytes.buffer]);
        else direct.serial_send_bytes(port, bytes);
      }
      input.clear();
    }
    function send(port, bytes) {
      if (destroyed) return;
      if (!input.has(port)) input.set(port, []);
      input.get(port).push(Uint8Array.from(bytes));
      if (!scheduled) {scheduled = true; queueMicrotask(flushInput);}
    }
    const call = (method, args = []) => {
      if (destroyed) return Promise.reject(new Error('The Linux runtime has stopped'));
      flushInput();
      if (direct) return Promise.resolve().then(() => direct[method](...args));
      return new Promise((resolve, reject) => {
        const id = ++sequence; pending.set(id, {resolve, reject});
        // Do not transfer caller buffers: the editor may still need them.
        worker.postMessage({type: 'call', id, method, args});
      });
    };
    const facade = {
      mode, ready,
      add_listener(name, fn) {
        if (!listeners.has(name)) {
          listeners.set(name, new Set());
          if (!name.startsWith('serial') && !lifecycle.includes(name) && name !== 'runtime-error') {
            if (worker) worker.postMessage({type: 'listen', name});
            else direct.add_listener(name, value => emit(name, value));
          }
        }
        listeners.get(name).add(fn);
      },
      remove_listener(name, fn) {listeners.get(name)?.delete(fn);},
      serial0_send(text) {send(0, encoder.encode(text));},
      serial_send_bytes: send,
      read_file(path) {return call('read_file', [path]);},
      create_file(path, bytes) {return call('create_file', [path, bytes]);},
      run() {return call('run');},
      stop() {return call('stop');},
      destroy() {
        if (destroyed) return;
        destroyed = true;
        if (worker) worker.terminate();
        else direct.destroy();
        fail(new Error('The Linux runtime has stopped'));
        input.clear(); listeners.clear();
      },
    };
    const normalized = absoluteOptions({...options, disable_keyboard: true, disable_mouse: true});
    if (mode === 'main') {
      if (!window.V86) throw new Error('The main-thread comparison requires vendor/libv86.js');
      direct = new V86(normalized);
      for (const name of lifecycle) direct.add_listener(name, value => emit(name, value));
      for (const port of [0, 1]) {
        let bytes = [], timer;
        const flush = () => {clearTimeout(timer); timer = null; if (bytes.length) {serial(port, Uint8Array.from(bytes)); bytes = [];}};
        direct.add_listener('serial' + port + '-output-byte', byte => {
          bytes.push(byte); if (bytes.length >= 8192) flush(); else if (!timer) timer = setTimeout(flush, 8);
        });
      }
    } else {
      worker = new Worker(asset('runtime-worker.js'), {name: 'MFEM Linux'});
      worker.onmessage = event => {
        const message = event.data;
        if (message.type === 'serial') serial(message.port, message.bytes);
        else if (message.type === 'event') emit(message.name, message.value);
        else if (message.type === 'fatal') fail(message.error);
        else if (message.type === 'result') {
          const task = pending.get(message.id); if (!task) return;
          pending.delete(message.id);
          message.error ? task.reject(new Error(message.error)) : task.resolve(message.value);
        }
      };
      worker.onerror = event => fail(event.message || 'Linux worker failed to start');
      worker.onmessageerror = () => fail('Could not receive a Linux worker message');
      worker.postMessage({type: 'init', options: normalized, runtimeURL:asset('vendor/libv86.js').href});
    }
    return facade;
  }
  window.WorkbenchRuntime = {create};
})();
