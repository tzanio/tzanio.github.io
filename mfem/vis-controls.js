/* Compact controls for the bundled GLVis State API. Key bindings follow
 * https://github.com/GLVis/glvis-js/blob/200a722811172bb070325163142dd84d8efaea25/live/index.html
 * See provenance/GLVIS-CONTROLS.md for attribution and the integration API. */
'use strict';
(function () {
  function attach(viewer, {onError = console.error, onPauseChange = () => {}, onStep = () => {},
    root = document, prefix = '', enqueue = action => action()} = {}) {
    // Preserve each view's references when its utility windows move to body.
    const elements = new Map([...root.querySelectorAll('[id]')].map(element => [element.id,element]));
    const get = id => elements.get(prefix + id);
    const toolbar = get('vis-toolbar');
    const panel = get('vis-controls');
    const visual = get('visual');
    const pauseButton = get('vis-pause');
    const stepButton = get('vis-step');
    const toggleButton = get('vis-toggle');
    const help = get('vis-help');
    let paused = false;
    let releasedSteps = 0;
    const frameWaiters = [];
    const abort = new AbortController();
    const suffix = prefix ? ' · view ' + prefix.split('-')[1] : '';
    const controlsWindow = WorkbenchWindows.attach(panel, {title:'GLVis controls' + suffix,width:350,
      anchor:toggleButton,returnFocus:visual,onClose:() => toggleButton.setAttribute('aria-expanded','false')});
    const helpWindow = WorkbenchWindows.attach(help, {title:'GLVis keyboard help' + suffix,width:'max-content',
      heading:help.querySelector('.bar'),closeButton:get('vis-help-close'),anchor:toggleButton,returnFocus:visual});

    function listen(element, event, callback, options = {}) {
      element.addEventListener(event, callback, {...options, signal: abort.signal});
    }
    function report(error) {
      onError(error?.message || String(error));
    }
    function focusViewer() {
      visual.focus({preventScroll: true});
    }
    function setPanel(open) {
      if (open) controlsWindow.open();else controlsWindow.close();
      toggleButton.setAttribute('aria-expanded', String(open));
    }
    function updatePauseButton() {
      pauseButton.textContent = paused ? '▶ Resume' : 'Ⅱ Pause';
      pauseButton.setAttribute('aria-pressed', String(paused));
      pauseButton.title = paused ? 'Resume incoming frames (Space)' : 'Pause incoming frames (Space)';
      stepButton.hidden = !paused;
    }
    function setPaused(value, {notify = true} = {}) {
      const changed = paused !== Boolean(value);
      paused = Boolean(value);
      releasedSteps = 0;
      updatePauseButton();
      if (!paused) frameWaiters.splice(0).forEach(resolve => resolve());
      if (changed && notify) Promise.resolve(onPauseChange(paused)).catch(report);
    }
    function beforeFrame() {
      if (!paused) return Promise.resolve();
      if (releasedSteps) { releasedSteps--; return Promise.resolve(); }
      return new Promise(resolve => frameWaiters.push(resolve));
    }
    function step() {
      if (!paused) return;
      const next = frameWaiters.shift();
      if (next) next();
      else releasedSteps++;
      Promise.resolve(onStep()).catch(report);
    }
    async function action(button) {
      const command = button.dataset.visAction;
      if (button.dataset.visKey !== undefined) {
        const key = button.dataset.visKey === 'Enter' ? 13 : button.dataset.visKey;
        await enqueue(() => viewer.sendKey(key));
        focusViewer();
      } else if (command === 'toggle') {
        setPanel(panel.hidden);
      } else if (command === 'pause') {
        setPaused(!paused);
        focusViewer();
      } else if (command === 'step') {
        step();
        focusViewer();
      } else if (command === 'screenshot') {
        await enqueue(() => viewer.saveScreenshot('glvis.png'));
      } else if (command === 'fullscreen') {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await (visual.closest('.sim-view') || visual.closest('.viewer')).requestFullscreen();
        focusViewer();
      } else if (command === 'help') {
        get('vis-help-text').textContent = await enqueue(() => viewer.getHelpString());
        helpWindow.open();
      }
    }
    for (const container of [toolbar, panel]) {
      listen(container, 'click', event => {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        action(button).catch(report);
      });
    }
    listen(visual, 'keydown', event => {
      if (event.code === 'Space' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) setPaused(!paused);
      }
    }, {capture: true});
    toolbar.querySelectorAll('button').forEach(button => { button.disabled = false; });
    if (!document.fullscreenEnabled) get('vis-fullscreen').hidden = true;
    updatePauseButton();
    return {
      get paused() { return paused; },
      setPaused, beforeFrame, step,
      closeWindows() {controlsWindow.close({restoreFocus:false});helpWindow.close({restoreFocus:false});},
      destroy() {
        abort.abort();
        setPaused(false, {notify:false});
        setPanel(false);
        controlsWindow.destroy();helpWindow.destroy();
        toolbar.querySelectorAll('button').forEach(button => { button.disabled = true; });
      },
    };
  }
  window.GLVisControls = {attach};
})();
