/* Small modeless workbench windows; no new browser windows or remote assets. */
'use strict';
(function () {
  const windows = new Set();
  let nextId = 0, layer = 100;
  function viewport() {
    const view = window.visualViewport;
    return {left:view?.offsetLeft || 0, top:view?.offsetTop || 0,
      width:view?.width || innerWidth, height:view?.height || innerHeight};
  }
  function attach(element, {title, width = 420, anchor, initialFocus, returnFocus, onClose,
    heading, closeButton} = {}) {
    const originalParent = element.parentNode;
    const nativeDialog = element instanceof HTMLDialogElement;
    const abort = new AbortController();
    const headingElement = heading || document.createElement('div');
    let close = closeButton || headingElement.querySelector('button');
    if (!heading) {
      const label = document.createElement('strong');label.textContent = title || 'Window';
      headingElement.append(label);
    }
    if (!close) {
      close = document.createElement('button');close.type = 'button';close.textContent = '×';
      headingElement.append(close);
    }
    close.classList.add('wb-window-close');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close ' + (title || 'window'));
    headingElement.classList.add('wb-window-titlebar');headingElement.tabIndex = 0;
    headingElement.setAttribute('aria-label', (title || 'Window') + ' — move with arrow keys');
    headingElement.title = 'Drag to move · Arrow keys move · Shift moves farther · Home centers';
    const label = headingElement.querySelector('strong,b,h2,span');
    if (label) {
      label.id ||= 'wb-window-title-' + (++nextId);
      element.setAttribute('aria-labelledby', label.id);
    } else element.setAttribute('aria-label', title || 'Window');
    const body = document.createElement('div');body.className = 'wb-window-body';
    for (const child of [...element.childNodes]) if (child !== headingElement) body.append(child);
    element.append(headingElement, body);element.classList.add('wb-window');
    element.setAttribute('role', 'dialog');element.setAttribute('aria-modal', 'false');
    element.style.setProperty('--wb-window-width', typeof width === 'number' ? width + 'px' : width);element.hidden = true;
    let opened = false, destroyed = false, position = null, previousFocus = null, drag = null;
    function listen(target, type, handler, options = {}) {
      target.addEventListener(type, handler, {...options, signal:abort.signal});
    }
    function parent() {return document.fullscreenElement || document.body;}
    function portal() {
      if (element.parentElement !== parent()) parent().append(element);
    }
    function raise() {element.style.zIndex = String(++layer);}
    function place(x, y) {
      const bounds = viewport(), margin = 8;
      element.style.setProperty('--wb-window-viewport-width', bounds.width + 'px');
      element.style.setProperty('--wb-window-viewport-height', bounds.height + 'px');
      const size = element.getBoundingClientRect();
      position = {x:Math.max(bounds.left + margin, Math.min(x, bounds.left + bounds.width - size.width - margin)),
        y:Math.max(bounds.top + margin, Math.min(y, bounds.top + bounds.height - size.height - margin))};
      element.style.left = position.x + 'px';element.style.top = position.y + 'px';
    }
    function constrain() {
      if (opened && position) place(position.x, position.y);
    }
    function center() {
      const bounds = viewport(), size = element.getBoundingClientRect();
      place(bounds.left + (bounds.width - size.width) / 2, bounds.top + (bounds.height - size.height) / 2);
    }
    function open({focus = true} = {}) {
      if (destroyed) return;
      if (!opened) previousFocus = document.activeElement;
      opened = true;portal();element.hidden = false;
      if (nativeDialog && !element.open) element.show();
      raise();
      if (position) constrain();
      else if (anchor?.isConnected) {
        const bounds = anchor.getBoundingClientRect();place(bounds.left, bounds.bottom + 8);
      } else center();
      if (focus) {
        const target = typeof initialFocus === 'function' ? initialFocus() : initialFocus;
        (target || headingElement).focus({preventScroll:true});
      }
    }
    function hide({restoreFocus = true} = {}) {
      if (!opened) return;
      const hadFocus = element.contains(document.activeElement);
      opened = false;drag = null;
      if (nativeDialog && element.open) element.close();
      element.hidden = true;
      if (restoreFocus && hadFocus) {
        const target = typeof returnFocus === 'function' ? returnFocus() : returnFocus || previousFocus;
        if (target?.isConnected) target.focus({preventScroll:true});
      }
      onClose?.();
    }
    listen(close, 'click', () => hide());
    listen(element, 'pointerdown', raise, {capture:true});
    listen(element, 'focusin', raise);
    listen(headingElement, 'pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button,a,input,select,textarea')) return;
      event.preventDefault();headingElement.focus({preventScroll:true});
      drag = {id:event.pointerId,x:event.clientX,y:event.clientY,left:position.x,top:position.y};
      headingElement.setPointerCapture(event.pointerId);
    });
    listen(headingElement, 'pointermove', event => {
      if (drag?.id === event.pointerId) place(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
    });
    const endDrag = event => {if (drag?.id === event.pointerId) drag = null;};
    listen(headingElement, 'pointerup', endDrag);listen(headingElement, 'pointercancel', endDrag);
    listen(headingElement, 'lostpointercapture', endDrag);
    listen(headingElement, 'keydown', event => {
      if (event.target !== headingElement || event.ctrlKey || event.metaKey || event.altKey) return;
      const directions = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
      const direction = directions[event.key], step = event.shiftKey ? 32 : 8;
      if (direction) place(position.x + direction[0] * step, position.y + direction[1] * step);
      else if (event.key === 'Home') center();else return;
      event.preventDefault();event.stopPropagation();
    });
    if (nativeDialog) listen(element, 'close', () => {if (opened && !element.open) hide();});
    const resizeObserver = new ResizeObserver(constrain);resizeObserver.observe(element);
    const api = {element,body,titlebar:headingElement,open,close:hide,raise,constrain,
      toggle() {opened ? hide() : open();}, get isOpen() {return opened;},
      relocate() {portal();constrain();},
      destroy() {
        if (destroyed) return;
        hide({restoreFocus:false});destroyed = true;abort.abort();resizeObserver.disconnect();windows.delete(api);
        element.remove();
      },
    };
    windows.add(api);portal();
    return api;
  }
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const top = [...windows].filter(item => item.isOpen).sort((a,b) => Number(b.element.style.zIndex) - Number(a.element.style.zIndex))[0];
    if (!top) return;
    event.preventDefault();event.stopImmediatePropagation();top.close();
  }, true);
  const constrain = () => windows.forEach(item => item.constrain());
  window.addEventListener('resize', constrain);
  window.visualViewport?.addEventListener('resize', constrain);
  window.visualViewport?.addEventListener('scroll', constrain);
  document.addEventListener('fullscreenchange', () => windows.forEach(item => item.relocate()));
  window.WorkbenchWindows = {attach, get openCount() {return [...windows].filter(item => item.isOpen).length;}};
})();
