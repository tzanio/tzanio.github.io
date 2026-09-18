'use strict';
let vm;
const subscribed = new Set();
const serial = [[], []], timers = [null, null];
const methods = new Set(['read_file', 'create_file', 'run', 'stop']);
function flush(port) {
  clearTimeout(timers[port]); timers[port] = null;
  if (!serial[port].length) return;
  const bytes = Uint8Array.from(serial[port]); serial[port] = [];
  postMessage({type: 'serial', port, bytes}, [bytes.buffer]);
}
function listen(name) {
  if (subscribed.has(name)) return;
  subscribed.add(name);
  vm.add_listener(name, value => {
    // XHR progress/errors contain DOM objects that cannot cross a worker port.
    if (name.startsWith('download-')) {
      value = Object.fromEntries(['file_index', 'file_count', 'file_name', 'lengthComputable', 'total', 'loaded']
        .filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
    }
    postMessage({type: 'event', name, value});
  });
}
self.onmessage = async event => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      if (vm) throw new Error('Linux already started');
      importScripts(message.downloadMonitorURL || 'download-monitor.js');
      self.WorkbenchDownloadMonitor.install(value => postMessage({type: 'download', value}));
      const runtimeURL = message.runtimeURL || new URL('vendor/libv86.js', self.location.href).href;
      // importScripts has no transfer-progress API. Report its completion,
      // while the monitor covers the VM's following XHR downloads in detail.
      importScripts(runtimeURL);
      postMessage({type: 'download', value: {url: runtimeURL, loaded: 0, total: 0,
        lengthComputable: false, done: true, error: false, status: 200}});
      vm = new V86(message.options);
      vm.add_listener('emulator-loaded',()=>{
        // Warm the guest's own cache during kernel boot. No bytes cross the UI
        // worker boundary, and ordinary demand reads remain the fallback.
        for(const path of message.preloadFiles || [])vm.read_file(path).catch(()=>{});
      });
      for (const name of ['emulator-ready', 'emulator-loaded', 'emulator-started',
        'emulator-stopped', 'download-progress', 'download-error']) listen(name);
      for (const port of [0, 1]) vm.add_listener('serial' + port + '-output-byte', byte => {
        serial[port].push(byte);
        if (serial[port].length >= 8192) flush(port);
        else if (!timers[port]) timers[port] = setTimeout(() => flush(port), 8);
      });
    } else if (message.type === 'finish-downloads') self.WorkbenchDownloadMonitor?.stop();
    else if (message.type === 'input') vm.serial_send_bytes(message.port, message.bytes);
    else if (message.type === 'listen') listen(message.name);
    else if (message.type === 'call') {
      if (!methods.has(message.method)) throw new Error('Unsupported VM method: ' + message.method);
      const value = await vm[message.method](...message.args);
      if (value instanceof Uint8Array) {
        // read_file can expose a slice of the live FS cache: copy before transfer.
        const copy = Uint8Array.from(value);
        postMessage({type: 'result', id: message.id, value: copy}, [copy.buffer]);
      } else postMessage({type: 'result', id: message.id, value});
    }
  } catch (error) {
    postMessage({type: message.id ? 'result' : 'fatal', id: message.id, error: error.message || String(error)});
  }
};
self.addEventListener('unhandledrejection', event => {
  event.preventDefault();
  postMessage({type: 'fatal', error: event.reason?.message || String(event.reason)});
});
