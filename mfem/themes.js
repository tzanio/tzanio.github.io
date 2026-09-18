/* Interface palettes. TMOG inspired by its full-color charcoal console.
 * No external assets are loaded; scientific GLVis color maps are untouched. */
'use strict';
(function () {
  const storageKey = 'mfem-workbench.theme.v1';
  const defaultTheme = 'tmog';
  const palettes = {
    tmog: {label:'TMOG', scheme:'dark', terminal:{
      background:'#1c1d1c', foreground:'#d9dad6', cursor:'#cc9ae7', cursorAccent:'#1c1d1c', selectionBackground:'#443750',
      black:'#292b28', red:'#f28d88', green:'#a3d57e', yellow:'#ebd275', blue:'#91b5f4', magenta:'#cc9ae7', cyan:'#8fd3d1', white:'#d9dad6',
      brightBlack:'#aaaDA5', brightRed:'#ffb0a8', brightGreen:'#c1eda2', brightYellow:'#ffe998', brightBlue:'#b5ccff', brightMagenta:'#e4bcfa', brightCyan:'#b6eeeb', brightWhite:'#f4f5ed',
    }},
    dark: {label:'Dark', scheme:'dark', terminal:{
      background:'#0c1118', foreground:'#d0dbe7', cursor:'#a6e7be', cursorAccent:'#0c1118', selectionBackground:'#344d68',
      black:'#17202b', red:'#f08080', green:'#a6e7be', yellow:'#e9cd87', blue:'#81b5f5', magenta:'#c49be8', cyan:'#83d5db', white:'#d0dbe7',
      brightBlack:'#8c9eb4', brightRed:'#ffaaaa', brightGreen:'#c2f2ce', brightYellow:'#ffe2a4', brightBlue:'#abcfff', brightMagenta:'#dfbcff', brightCyan:'#b0edf1', brightWhite:'#f5f8ff',
    }},
    light: {label:'Light', scheme:'light', terminal:{
      background:'#f7f9fc', foreground:'#253447', cursor:'#176145', cursorAccent:'#ffffff', selectionBackground:'#cadced',
      black:'#253447', red:'#ad2638', green:'#226438', yellow:'#805519', blue:'#255faf', magenta:'#824295', cyan:'#156c76', white:'#5a6678',
      brightBlack:'#596a7e', brightRed:'#ba253b', brightGreen:'#226b39', brightYellow:'#815407', brightBlue:'#255dbb', brightMagenta:'#844395', brightCyan:'#176570', brightWhite:'#253447',
    }},
  };
  const terminals = new Set();
  const selects = new Set();
  let current = defaultTheme;
  function valid(id) { return Object.prototype.hasOwnProperty.call(palettes, id); }
  function terminalTheme(id = current) { return {...palettes[valid(id) ? id : defaultTheme].terminal}; }
  function apply(id, {persist = true} = {}) {
    current = valid(id) ? id : defaultTheme;
    document.documentElement.dataset.theme = current;
    document.documentElement.style.colorScheme = palettes[current].scheme;
    if (persist) {try {localStorage.setItem(storageKey, current);} catch {}}
    for (const terminal of terminals) terminal.options.theme = terminalTheme();
    for (const select of selects) select.value = current;
    window.dispatchEvent(new CustomEvent('workbench-themechange', {detail:{theme:current}}));
    return current;
  }
  function bindTerminal(terminal) {
    terminals.add(terminal);
    terminal.options.theme = terminalTheme();
    // Keep ANSI/256-color shell output readable on both pale and dark surfaces.
    terminal.options.minimumContrastRatio = 4.5;
    return () => terminals.delete(terminal);
  }
  // Read xterm's rendered cell dimensions so shell columns fit the pane.
  function terminalGeometry(terminal) {
    const screen = terminal.element?.querySelector('.xterm-screen');
    const width = screen?.getBoundingClientRect().width / terminal.cols;
    const height = screen?.getBoundingClientRect().height / terminal.rows;
    return {width:width > 0 ? width : 7.83,height:height > 0 ? height : 15};
  }
  function mount(container = document.querySelector('header nav')) {
    if (!container) return null;
    const existing = container.querySelector('.wb-theme-picker');
    if (existing) return existing;
    const label = document.createElement('label');
    label.className = 'wb-theme-picker';
    const caption = document.createElement('span');
    caption.textContent = 'Theme';
    const select = document.createElement('select');
    select.id = 'theme-select';
    select.setAttribute('aria-label', 'Interface theme');
    select.title = 'Interface colors · GLVis color maps stay unchanged';
    for (const [id, theme] of Object.entries(palettes)) {
      const option = document.createElement('option');
      option.value = id; option.textContent = theme.label;
      select.append(option);
    }
    select.value = current;
    select.addEventListener('change', () => apply(select.value));
    selects.add(select); label.append(caption, select); container.append(label);
    return label;
  }
  let saved;
  try {saved = localStorage.getItem(storageKey);} catch {}
  // The earlier phosphor interpretation was replaced by the full-color console.
  const migrated = ['tmog-green','tmog-amber','phosphor-green','phosphor-amber'].includes(saved);
  apply(migrated ? defaultTheme : saved, {persist:migrated});
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) apply(event.newValue, {persist:false});
  });
  window.WorkbenchThemes = Object.freeze({
    apply, mount, terminalTheme, bindTerminal, terminalGeometry, get current() {return current;},
    themes:Object.freeze(Object.entries(palettes).map(([id, {label}]) => Object.freeze({id, label}))),
  });
})();
