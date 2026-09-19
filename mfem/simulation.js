/* Native GLVis views, bounded local recording, and independent replay cameras. */
'use strict';
(function () {
  const MiB = 1024 * 1024;
  const decode = new TextDecoder(), encode = new TextEncoder();
  const MAX_VIEWS = 4, MAX_RECORDS = 4096, LIVE_CACHE_LIMIT = 128 * MiB;
  const controlGroups = [
    ['Mesh', [['m','Mesh'],['a','Axes'],['e','Elements'],['o','Resolution']]],
    ['Colors', [['P','← Palette','Previous palette'],['p','Palette →','Next palette'],['c','Colorbar'],['l','Light'],['T','Material'],['g','Background']]],
    ['View', [['R','Reset 2D'],['r','Reset 3D'],['j','Perspective'],['*','Zoom +'],['/','Zoom −'],['+','Stretch +'],['-','Stretch −'],['.','Spin']]],
  ];

  function create(host, {rpc, readFile, upload, startupPreview, notice = console.warn, diagnostics = {}}) {
    for (const name of ['frames','updates','commands']) diagnostics[name] ??= 0;
    host.classList.add('simulation-workbench');
    host.innerHTML = `<div class="bar sim-heading"><strong>GLVis</strong><select id="sim-phone-views" class="sim-phone-views" aria-label="Visualization camera" hidden></select><button class="sim-record-toggle" id="sim-record-toggle" aria-expanded="false" aria-controls="sim-recording">Record</button><button id="sim-add-view" title="Add an independent GLVis camera">+ View</button><button data-maximize="viewer" title="Maximize visualization" aria-label="Maximize visualization">□</button></div>
      <div id="sim-recording" class="sim-recording"><button id="sim-record" aria-pressed="false" title="Keep incoming frames in this browser tab">● Record</button><label>Cap <input id="sim-record-cap" aria-label="Recording storage cap in MiB" type="number" min="1" max="256" step="1" value="32"> MiB</label><button id="sim-record-clear" disabled>Clear</button><span id="sim-record-status" class="sim-record-status">Recording off · memory only</span></div>
      <div class="sim-layout" data-views="1"></div>`;
    const get = id => host.querySelector('#' + id);
    const layout = host.querySelector('.sim-layout');
    const streams = new Map(), pool = [];
    const recording = {enabled:false,capBytes:32 * MiB,bytes:0,frames:[],dropped:0,nextId:0};
    let destroyed = false, resizeRequest = 0;
    const activeViews = () => pool.filter(view => view.active);
    const report = error => notice('GLVis: ' + (error?.message || error));

    function streamState(client) {
      if (!streams.has(client)) streams.set(client, {
        client,title:'Field ' + client,frame:0,data:null,commands:[],ended:false,
        paused:false,stepCredits:0,waiters:[],queue:Promise.resolve(),lastRecord:null,
      });
      return streams.get(client);
    }
    function boundViews(client) {return activeViews().filter(view => view.client === client)}
    function enqueueView(view, action) {
      const result = view.queue.then(() => {if (view.active && !destroyed) return action()});
      view.queue = result.catch(report);
      return result;
    }
    function syncPaused(state) {
      for (const view of boundViews(state.client)) {
        view.controls?.setPaused(state.paused, {notify:false});
        updateViewStatus(view);
      }
    }
    async function setPaused(state, paused, notify = true) {
      state.paused = Boolean(paused);state.stepCredits = 0;
      if (!state.paused) state.waiters.splice(0).forEach(resolve => resolve());
      syncPaused(state);
      if (notify && !state.ended) await rpc(state.paused ? 'vis-pause' : 'vis-play', {client:state.client});
    }
    function beforeStreamFrame(state) {
      if (!state.paused || !boundViews(state.client).length) return Promise.resolve();
      if (state.stepCredits) {state.stepCredits--;return Promise.resolve()}
      return new Promise(resolve => state.waiters.push(resolve));
    }
    async function stepStream(state) {
      if (!state.paused || state.ended) return;
      const next = state.waiters.shift();
      if (next) next();else state.stepCredits++;
      await rpc('vis-play', {client:state.client,step:true});
    }
    function updateSelectors() {
      for (const view of activeViews()) {
        const select = view.get('vis-stream');select.replaceChildren();
        for (const state of streams.values()) {
          const option = document.createElement('option');
          option.value = state.client;option.textContent = state.title;select.append(option);
        }
        select.hidden = streams.size < 2;
        if (view.client !== null) select.value = String(view.client);
      }
    }
    function updateViewStatus(view) {
      const state = streams.get(view.client), label = view.get('view-status');
      if (!state) {label.textContent = view.preview ? 'ex1 preview · waiting for ./ex1' : 'Listening on localhost:19916';return}
      label.textContent = view.mode === 'replay' ? 'Replay · frame ' + view.displayedFrame :
        'Connected · frame ' + view.displayedFrame + (state.paused ? ' · paused' : state.ended ? ' · complete' : ' · live');
      label.title = state.title;
      view.get('sim-range-label').hidden = !view.range.enabled;
      view.get('sim-range-label').textContent = 'Fixed colors: ' + view.range.min + ' … ' + view.range.max;
      updateTimeline(view);
    }
    function startRenderLoop(view, module) {
      if (view.raf || !view.active || destroyed) return;
      const draw = () => {
        view.raf = 0;
        if (!view.active || destroyed) return;
        module.iterVisualization();
        view.raf = requestAnimationFrame(draw);
      };
      view.raf = requestAnimationFrame(draw);
    }
    function initializeViewer(view) {
      const start = performance.now();
      const viewer = new glvis.State(view.visual, Math.max(1,view.visual.clientWidth),Math.max(1,view.visual.clientHeight),undefined, {
        // SDL's native title belongs to this renderer, never the browser tab.
        // Field names continue to come from each stream's window_title command.
        setWindowTitle:title => {view.nativeTitle = title},
      });
      // Compile/instantiate the first WASM module while Linux boots, but do not
      // cover the startup placeholder or start drawing before a real solution.
      viewer.canvas_.style.display = 'none';
      viewer.emglv_.then(() => {
        if (view.id === 1) {
          diagnostics.rendererReadyMs = performance.now();
          diagnostics.rendererInitMs = performance.now() - start;
        }
      }).catch(report);
      // State's default render loop is permanent. Pool at most four modules and
      // stop loops for hidden slots, so adding/removing panes cannot leak WASM.
      viewer._startVis = module => {
        viewer.emsetup_ = true;
        module.setCanvasId(viewer.canvas_.id);
        viewer.canvas_.style.display = '';
        view.get('view-placeholder').hidden = true;
        startRenderLoop(view,module);
      };
      view.viewer = viewer;
      return viewer;
    }
    function rangeCommands(view) {
      return view.range.enabled ? `\nautoscale off\nvaluerange ${view.range.min} ${view.range.max}\n` : '';
    }
    async function showStartupPreview(view, url) {
      // This bundled stream was generated by the real default MFEM ./ex1.
      // It is explicitly a preview, never a VM event, live field, recorded
      // frame, inspectable result, or evidence that Linux has finished booting.
      const generation = view.generation;
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Preview unavailable (' + response.status + ')');
        const preview = await response.json();
        if (preview.format !== 1 || preview.mfemVersion !== '4.10' || preview.command !== './ex1' ||
            typeof preview.data !== 'string' || !preview.data.startsWith('solution\n')) throw new Error('Unsupported startup preview');
        await view.viewer.emglv_;
        return await enqueueView(view, async () => {
          // A live bind cancels even a slow preview fetch/initialization. Once a
          // real solve arrives, no later preview is allowed to replace it.
          if (generation !== view.generation || view.client !== null) return false;
          view.viewer.setCanvasSize(Math.max(1,view.visual.clientWidth),Math.max(1,view.visual.clientHeight));
          await view.viewer.display(preview.data + '\n' + (preview.commands || []).join('\n') + '\n');
          if (generation !== view.generation || view.client !== null) return false;
          view.preview = true;updateViewStatus(view);
          diagnostics.previewFirstRenderMs = performance.now();
          return true;
        });
      } catch (error) {
        // The real guest solve is independent of this optional first image.
        diagnostics.previewError = error.message || String(error);
        console.warn('Startup preview:',diagnostics.previewError);
        return false;
      }
    }
    async function render(view, frame, {force = false} = {}) {
      if (!frame?.data) return;
      const generation = view.generation;
      return enqueueView(view, async () => {
        if (generation !== view.generation || frame.client !== view.client) return;
        const viewer = view.viewer || initializeViewer(view);
        // A prewarmed module may have been created before a layout/viewport
        // change. Update canvas dimensions before the native scene is opened.
        if (!viewer.emsetup_) viewer.setCanvasSize(Math.max(1,view.visual.clientWidth),Math.max(1,view.visual.clientHeight));
        const update = !force && !view.rangeDirty && view.displayedClient === frame.client;
        const fullStream = () => frame.data + '\n' + (frame.commands || []).join('\n') + '\n' + rangeCommands(view);
        if (update) {
          // The upstream update() fallback starts display() without awaiting it
          // and omits scene commands. Await that fallback here, including fixed
          // limits, if a stream changes between incompatible field types.
          if ((await viewer._display(frame.data,true)) !== 0) await viewer.display(fullStream());
          diagnostics.updates++;
        } else {
          await viewer.display(fullStream());
          view.displayedClient = frame.client;view.rangeDirty = false;
        }
        view.preview = false;
        if (!view.controls) {
          view.controls = GLVisControls.attach(viewer, {
            root:view.element,prefix:view.prefix,onError:notice,
            enqueue:action => enqueueView(view,action),
            onPauseChange:paused => setPaused(streamState(view.client),paused),
            onStep:() => stepStream(streamState(view.client)),
          });
        }
        view.controls.setPaused(streamState(view.client).paused, {notify:false});
        view.inspectionFrame = {client:frame.client,frame:frame.frame,data:frame.data};
        if (!view.inspector && window.MeshInspector && upload) {
          view.inspector = MeshInspector.attach({button:view.get('vis-inspect'),visual:view.visual,
            rpc,readFile,upload,getFrame:() => view.inspectionFrame,suffix:view.id > 1 ? ' · view ' + view.id : ''});
        }
        view.get('vis-inspect').disabled = !view.inspector;
        view.displayedFrame = frame.frame;view.displayedRecord = frame.id || null;
        diagnostics.frames++;updateViewStatus(view);
      });
    }
    function latestFrame(state) {
      return {client:state.client,data:state.data,frame:state.frame,commands:state.commands};
    }
    function stopPlayback(view) {
      view.playing = false;clearTimeout(view.playTimer);view.playTimer = null;
      view.get('sim-replay-play').textContent = '▶ Replay';
    }
    async function bindView(view, client) {
      const previous = streams.get(view.client);
      stopPlayback(view);view.generation++;view.client = client;view.mode = 'live';view.replayId = null;
      view.displayedClient = null;view.displayedFrame = 0;
      if (previous && previous.client !== client && !boundViews(previous.client).length && previous.paused) {
        setPaused(previous,false).catch(report);
      }
      const state = streamState(client);
      view.controls?.setPaused(state.paused, {notify:false});
      updateSelectors();updateViewStatus(view);
      if (state.data) await render(view,latestFrame(state),{force:true});
    }
    async function goLive(view) {
      stopPlayback(view);view.generation++;view.mode = 'live';view.replayId = null;
      const state = streams.get(view.client);
      if (state?.data) await render(view,latestFrame(state));
      updateViewStatus(view);
    }
    function recordsFor(view) {return recording.frames.filter(frame => frame.client === view.client)}
    function updateTimeline(view) {
      const frames = recordsFor(view), timeline = view.get('sim-timeline');
      timeline.hidden = !frames.length && view.mode !== 'replay';
      const slider = view.get('sim-replay-slider');
      slider.max = String(Math.max(0,frames.length - 1));slider.disabled = !frames.length;
      let index = frames.findIndex(frame => frame.id === view.replayId);
      const expired = view.mode === 'replay' && index < 0;
      if (index < 0) index = view.mode === 'live' ? Math.max(0,frames.length - 1) : 0;
      slider.value = String(index);
      view.get('sim-live').disabled = view.mode === 'live';
      view.get('sim-replay-play').disabled = !frames.length;
      const status = view.get('sim-replay-status');status.dataset.replay = String(view.mode === 'replay');
      status.textContent = view.mode === 'replay' ? `Replay · frame ${view.displayedFrame}${expired ? ' (expired from recording)' : ''} · ${frames.length} retained` :
        `Live · ${frames.length} recorded frame${frames.length === 1 ? '' : 's'} · 5 fps playback`;
    }
    async function replayFrame(view, record) {
      if (!record) return;
      view.generation++;view.mode = 'replay';view.replayId = record.id;
      await render(view,{...record,data:decode.decode(record.bytes)});
      updateTimeline(view);
    }
    async function playback(view) {
      if (view.playing) {stopPlayback(view);return}
      let frames = recordsFor(view);if (!frames.length) return;
      view.playing = true;view.get('sim-replay-play').textContent = 'Ⅱ Replay';
      let current = frames.findIndex(frame => frame.id === view.replayId);
      if (view.mode !== 'replay' || current === frames.length - 1) current = -1;
      const tick = async () => {
        if (!view.playing || !view.active) return;
        frames = recordsFor(view);
        const index = current < 0 ? 0 : frames.findIndex(frame => frame.id === view.replayId) + 1;
        const frame = frames[index];
        if (!frame) {stopPlayback(view);return}
        try {
          await replayFrame(view,frame);current = index;
          if (view.playing) view.playTimer = setTimeout(tick,200);
        } catch (error) {stopPlayback(view);report(error)}
      };
      await tick();
    }
    function recordingCost(record) {
      return record.bytes.byteLength + encode.encode(record.title + record.commands.join('\n')).byteLength + 128;
    }
    function enforceRecordingCap() {
      while (recording.frames.length && (recording.bytes > recording.capBytes || recording.frames.length > MAX_RECORDS)) {
        const removed = recording.frames.shift();recording.bytes -= removed.cost;recording.dropped++;
        if (streams.get(removed.client)?.lastRecord === removed) streams.get(removed.client).lastRecord = null;
      }
      updateRecording();
    }
    function capture(state, bytes) {
      if (!recording.enabled || !state.frame) return;
      if (recording.frames.some(frame => frame.client === state.client && frame.frame === state.frame)) return;
      const record = {id:++recording.nextId,client:state.client,frame:state.frame,title:state.title,
        commands:state.commands.slice(),bytes:bytes.slice()};
      record.cost = recordingCost(record);
      if (record.cost > recording.capBytes) {
        recording.dropped++;updateRecording();
        notice('This frame exceeds the recording cap; increase Cap to retain it.');return;
      }
      recording.frames.push(record);recording.bytes += record.cost;state.lastRecord = record;
      enforceRecordingCap();
    }
    function updateRecordedCommands(state) {
      const record = state.lastRecord;
      if (!record || record.frame !== state.frame) return;
      recording.bytes -= record.cost;
      record.commands = state.commands.slice();record.title = state.title;
      record.cost = recordingCost(record);recording.bytes += record.cost;
      enforceRecordingCap();
    }
    function updateRecording() {
      get('sim-record').setAttribute('aria-pressed',String(recording.enabled));
      get('sim-record').textContent = recording.enabled ? '■ Stop recording' : '● Record';
      get('sim-record-clear').disabled = !recording.frames.length;
      get('sim-record-status').textContent = recording.frames.length ?
        `${recording.frames.length} frames · ${(recording.bytes / MiB).toFixed(1)} / ${recording.capBytes / MiB} MiB` +
          (recording.dropped ? ` · ${recording.dropped} expired` : '') :
        (recording.enabled ? 'Recording · waiting for frames' : 'Recording off · memory only');
      for (const view of activeViews()) updateTimeline(view);
    }
    function limitLiveCache() {
      let total = 0;
      for (const state of [...streams.values()].reverse()) {
        if (state.data) total += state.data.length * 2;
        if (total > LIVE_CACHE_LIMIT && !boundViews(state.client).length && state.data) {
          total -= state.data.length * 2;state.data = null;
        }
      }
    }
    async function processMessage(state, message) {
      if (message.event === 'glvis') {
        try {
          const primary = activeViews()[0];
          if (primary.client === null || (primary.mode === 'live' && !state.frame && streams.get(primary.client)?.ended)) {
            await bindView(primary,state.client);
          }
          const bytes = await readFile(message.path);
          await beforeStreamFrame(state);
          state.data = decode.decode(bytes);state.frame = message.frame || state.frame + 1;state.ended = false;
          capture(state,bytes);
          await Promise.all(boundViews(state.client).filter(view => view.mode === 'live')
            .map(view => render(view,latestFrame(state))));
          limitLiveCache();updateSelectors();
        } finally {await rpc('unlink',{path:message.path})}
      } else if (message.event === 'glvis-end') {
        state.ended = true;
        for (const view of boundViews(state.client)) updateViewStatus(view);
      } else if (message.event === 'glvis-command') {
        diagnostics.commands++;
        const {command,args = []} = message;
        if (command === 'window_title') {
          state.title = args[0];updateRecordedCommands(state);updateSelectors();
          for (const view of boundViews(state.client)) updateViewStatus(view);
          return;
        }
        if (command === 'pause') {
          if (boundViews(state.client).length) await setPaused(state,true,false);
          else await rpc('vis-play',{client:state.client});
          return;
        }
        if (['autopause','window_size','window_geometry','screenshot'].includes(command)) return;
        const quoted = ['plot_caption','axis_labels','axis_numberformat','colorbar_numberformat'].includes(command);
        state.commands.push(command + ' ' + args.map(arg => quoted ? "'" + String(arg).replaceAll("'",'') + "'" : arg).join(' '));
        if (state.commands.length > 128) state.commands.shift();
        updateRecordedCommands(state);
        await Promise.all(boundViews(state.client).filter(view => view.mode === 'live' && view.viewer).map(view =>
          command === 'keys' ? enqueueView(view,() => view.viewer.sendKeyStr(args[0])) :
            render(view,latestFrame(state),{force:true})));
      }
    }
    function handle(message) {
      const state = streamState(message.client);
      const result = state.queue.then(() => processMessage(state,message));
      state.queue = result.catch(report);
      return result;
    }
    function paneMarkup(prefix, removable) {
      const id = name => prefix + name;
      const groups = controlGroups.map(([name,buttons]) => `<div class="vis-control-group"><span>${name}</span><div>${buttons.map(([key,label,aria]) => `<button data-vis-key="${key}" title="${label} (${key})"${aria ? ` aria-label="${aria}"` : ''}>${label}</button>`).join('')}</div></div>`).join('');
      return `<div class="bar"><span>GLVis</span><select class="sim-field" id="${id('vis-stream')}" aria-label="Visualization field" hidden></select><span class="sim-status" id="${id('view-status')}">Listening on localhost:19916</span>${removable ? '<button class="sim-remove" aria-label="Remove visualization view">×</button>' : ''}</div>
        <div id="${id('vis-toolbar')}" class="vis-toolbar" aria-label="Visualization toolbar"><button id="${id('vis-toggle')}" data-vis-action="toggle" aria-expanded="false" aria-controls="${id('vis-controls')}" disabled>Controls ⌄</button><button id="${id('vis-inspect')}" aria-label="Inspect displayed mesh" disabled>Inspect</button><button id="${id('vis-pause')}" data-vis-action="pause" aria-pressed="false" disabled>Ⅱ Pause</button><button id="${id('vis-step')}" data-vis-action="step" hidden disabled>Step →</button><span class="vis-tool-spacer"></span><button data-vis-action="screenshot" aria-label="Save GLVis screenshot" disabled>PNG ↓</button><button id="${id('vis-fullscreen')}" data-vis-action="fullscreen" aria-label="Fullscreen visualization" disabled>⛶</button></div>
        <div id="${id('vis-controls')}" class="vis-controls" aria-label="GLVis visualization controls" hidden>${groups}<form class="sim-range"><label><input id="${id('sim-fixed-range')}" type="checkbox"> Fixed color range</label><label>Min <input id="${id('sim-range-min')}" type="number" step="any" value="0" aria-label="Minimum color value"></label><label>Max <input id="${id('sim-range-max')}" type="number" step="any" value="1" aria-label="Maximum color value"></label><button type="submit">Apply</button><small>Keep these limits as new frames arrive.</small></form><div class="vis-control-footer"><button data-vis-action="help">Keyboard help</button><a href="https://glvis.org/live/" target="_blank" rel="noopener">Web GLVis ↗</a></div></div>
        <div class="sim-visual" id="${id('visual')}" tabindex="0"><div class="sim-placeholder" id="${id('view-placeholder')}"><span class="wire">◇</span><p>Run an example.<br>Its solution appears here.</p></div><span id="${id('sim-range-label')}" class="sim-range-label" hidden></span></div>
        <div class="sim-timeline" id="${id('sim-timeline')}" hidden><span id="${id('sim-replay-status')}" class="sim-replay-status"></span><button id="${id('sim-replay-play')}">▶ Replay</button><input id="${id('sim-replay-slider')}" type="range" min="0" max="0" step="1" value="0" aria-label="Recorded simulation frame"><button id="${id('sim-live')}">Return live</button></div>
        <dialog id="${id('vis-help')}" class="sim-help"><div class="bar"><b>GLVis keyboard help</b><button id="${id('vis-help-close')}" aria-label="Close keyboard help">Close ×</button></div><pre id="${id('vis-help-text')}"></pre></dialog>`;
    }
    function addView() {
      let view = pool.find(item => !item.active);
      if (!view && pool.length >= MAX_VIEWS) return null;
      if (!view) {
        const index = pool.length, element = document.createElement('section');
        const prefix = index ? 'view-' + (index + 1) + '-' : '';
        element.className = 'sim-view';element.dataset.view = String(index + 1);
        element.innerHTML = paneMarkup(prefix,index > 0);layout.append(element);
        view = {id:index + 1,prefix,element,visual:element.querySelector('#' + prefix + 'visual'),active:true,
          client:null,viewer:null,controls:null,queue:Promise.resolve(),generation:0,mode:'live',
          displayedClient:null,displayedFrame:0,displayedRecord:null,replayId:null,playing:false,
          range:{enabled:false,min:0,max:1},rangeDirty:false,raf:0};
        const elements = new Map([...element.querySelectorAll('[id]')].map(node => [node.id,node]));
        view.get = name => elements.get(prefix + name);pool.push(view);
        view.get('vis-stream').onchange = event => bindView(view,Number(event.target.value)).catch(report);
        view.get('sim-live').onclick = () => goLive(view).catch(report);
        view.get('sim-replay-play').onclick = () => playback(view).catch(report);
        view.get('sim-replay-slider').oninput = event => {
          stopPlayback(view);replayFrame(view,recordsFor(view)[Number(event.target.value)]).catch(report);
        };
        element.querySelector('.sim-range').onsubmit = event => {
          event.preventDefault();
          const min = Number(view.get('sim-range-min').value), max = Number(view.get('sim-range-max').value);
          if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {notice('Color range needs finite Min < Max.');return}
          view.range = {enabled:view.get('sim-fixed-range').checked,min,max};view.rangeDirty = true;
          const record = recording.frames.find(frame => frame.id === view.replayId);
          const frame = view.mode === 'replay' && record ? {...record,data:decode.decode(record.bytes)} :
            streams.has(view.client) ? latestFrame(streams.get(view.client)) : null;
          render(view,frame,{force:true}).catch(report);updateViewStatus(view);
        };
        if (index) element.querySelector('.sim-remove').onclick = () => removeView(view);
        new ResizeObserver(resize).observe(view.visual);
      } else {
        view.active = true;view.element.hidden = false;
        if (view.viewer?.emsetup_) view.viewer.emglv_.then(module => startRenderLoop(view,module));
      }
      const first = activeViews()[0];
      if (first !== view && first.client !== null) bindView(view,first.client).catch(report);
      updateLayout();selectPhoneView(view.id);return view;
    }
    function removeView(view) {
      if (view.id === 1) return;
      const state = streams.get(view.client);
      stopPlayback(view);view.active = false;view.generation++;view.element.hidden = true;
      view.controls?.closeWindows();
      view.inspector?.destroy();view.inspector = null;view.inspectionFrame = null;
      cancelAnimationFrame(view.raf);view.raf = 0;view.client = null;
      if (state?.paused && !boundViews(state.client).length) setPaused(state,false).catch(report);
      updateLayout();
    }
    function updateLayout() {
      layout.dataset.views = String(activeViews().length);
      get('sim-add-view').disabled = activeViews().length >= MAX_VIEWS;
      const picker=get('sim-phone-views'),previous=Number(picker.value);
      picker.replaceChildren(...activeViews().map(view=>new Option('View '+view.id,String(view.id))));
      picker.hidden=activeViews().length<2;
      selectPhoneView(activeViews().some(view=>view.id===previous)?previous:activeViews()[0].id);
      updateSelectors();resize();
    }
    function selectPhoneView(id) {
      get('sim-phone-views').value=String(id);
      for(const view of activeViews())view.element.dataset.phoneActive=String(view.id===id);
      resize();
    }
    function resize() {
      if (resizeRequest || destroyed) return;
      resizeRequest = requestAnimationFrame(() => {
        resizeRequest = 0;
        for (const view of activeViews()) {
          const width = Math.max(1,view.visual.clientWidth),height = Math.max(1,view.visual.clientHeight);
          if (view.viewer && (width !== view.viewer.logical_width_ || height !== view.viewer.logical_height_)) {
            enqueueView(view,() => view.viewer.emsetup_ ? view.viewer.setSize(width,height) : view.viewer.setCanvasSize(width,height)).catch(report);
          }
        }
      });
    }
    get('sim-add-view').onclick = addView;
    get('sim-phone-views').onchange=event=>selectPhoneView(Number(event.target.value));
    get('sim-record-toggle').onclick=event=>{
      const open=host.dataset.recordPanel!=='open';host.dataset.recordPanel=open?'open':'closed';
      event.currentTarget.setAttribute('aria-expanded',String(open));resize();
    };
    get('sim-record').onclick = () => {
      recording.enabled = !recording.enabled;
      if (recording.enabled) for (const state of streams.values()) {
        if (state.data) capture(state,encode.encode(state.data));
      }
      updateRecording();
    };
    get('sim-record-cap').onchange = event => {
      const cap = Number(event.target.value);
      if (!Number.isInteger(cap) || cap < 1 || cap > 256) {
        notice('Recording cap must be an integer from 1 to 256 MiB.');event.target.value = recording.capBytes / MiB;return;
      }
      recording.capBytes = cap * MiB;enforceRecordingCap();
    };
    get('sim-record-clear').onclick = () => {
      recording.frames.length = 0;recording.bytes = 0;recording.dropped = 0;
      for (const state of streams.values()) state.lastRecord = null;
      for (const view of activeViews()) goLive(view).catch(report);
      updateRecording();
    };
    const primary = addView();initializeViewer(primary);updateRecording();
    const previewReady = startupPreview ? showStartupPreview(primary,startupPreview) : Promise.resolve(false);
    return {
      handle,resize,streams,recording,previewReady,
      get viewer() {return activeViews()[0]?.viewer},
      get controls() {return activeViews()[0]?.controls},
      get views() {return activeViews()},
      destroy() {
        destroyed = true;cancelAnimationFrame(resizeRequest);
        for (const state of streams.values()) state.waiters.splice(0).forEach(resolve => resolve());
        for (const view of pool) {stopPlayback(view);cancelAnimationFrame(view.raf);view.controls?.destroy();view.inspector?.destroy()}
      },
    };
  }
  window.SimulationWorkbench = {create};
})();
