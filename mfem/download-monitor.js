/* Observe startup transfers without changing the libraries' request handling. */
(function (scope) {
  'use strict';
  let uninstall = () => {};
  function install(report) {
    uninstall();
    if (typeof scope.XMLHttpRequest !== 'function' || typeof report !== 'function') return;
    const prototype = scope.XMLHttpRequest.prototype;
    const originalOpen = prototype.open, originalSend = prototype.send;
    const requests = new WeakMap(), active = new Set();
    let enabled = true;
    const publish = value => {
      // A progress UI must never interrupt a library's request or retry logic.
      try {if (enabled) report(value);} catch (_) {}
    };
    const detach = record => {
      for (const [name, listener] of record.listeners) record.xhr.removeEventListener(name, listener);
      record.listeners.length = 0;
      active.delete(record);
    };
    function open(method, url) {
      const result = Reflect.apply(originalOpen, this, arguments);
      const previous = requests.get(this);
      if (previous) detach(previous);
      requests.delete(this);
      try {
        const absolute = new URL(url, scope.location.href);
        if (absolute.origin === scope.location.origin) requests.set(this, {
          xhr: this, url: absolute.href, loaded: 0, total: 0,
          lengthComputable: false, lastReport: -Infinity, listeners: [], finished: false,
        });
      } catch (_) {}
      return result;
    }
    function send() {
      const record = requests.get(this);
      if (!enabled || !record || active.has(record) || record.finished) {
        return Reflect.apply(originalSend, this, arguments);
      }
      const emit = (event, done, failed) => {
        if (record.finished) return;
        if (Number.isFinite(event?.loaded)) record.loaded = Math.max(record.loaded, event.loaded);
        if (event?.lengthComputable && Number.isFinite(event.total)) {
          record.total = event.total;
          record.lengthComputable = true;
        }
        let status = 0;
        try {status = this.status;} catch (_) {}
        const error = Boolean(failed || (done && (status < 200 || status >= 400)));
        if (done && !error && record.lengthComputable) record.loaded = Math.max(record.loaded, record.total);
        const now = scope.performance?.now() ?? Date.now();
        // Cap progress messages at about twelve per second per transfer. A
        // completion always passes through, including small cached responses.
        if (!done && now - record.lastReport < 80) return;
        record.lastReport = now;
        if (done) {record.finished = true; detach(record);}
        publish({url: record.url, loaded: record.loaded, total: record.total,
          lengthComputable: record.lengthComputable, done, error, status});
      };
      record.listeners = [
        ['progress', event => emit(event, false, false)],
        ['load', event => emit(event, true, false)],
        ['error', event => emit(event, true, true)],
        ['abort', event => emit(event, true, true)],
        ['timeout', event => emit(event, true, true)],
      ];
      active.add(record);
      for (const [name, listener] of record.listeners) this.addEventListener(name, listener);
      emit(null, false, false);
      try {return Reflect.apply(originalSend, this, arguments);}
      catch (error) {emit(null, true, true); throw error;}
    }
    prototype.open = open;
    prototype.send = send;
    uninstall = () => {
      enabled = false;
      for (const record of active) detach(record);
      if (prototype.open === open) prototype.open = originalOpen;
      if (prototype.send === send) prototype.send = originalSend;
      uninstall = () => {};
    };
  }
  scope.WorkbenchDownloadMonitor = {install, stop: () => uninstall()};
})(typeof self === 'undefined' ? window : self);
