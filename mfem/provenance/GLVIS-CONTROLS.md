# GLVis visualization controls

The workstation's compact controls use the same GLVis key bindings as the
[official web viewer](https://glvis.org/live/), with no remote scripts or UI
framework dependencies. Bindings were checked against
[GLVis/glvis-js `live/index.html`, commit 200a722811172bb070325163142dd84d8efaea25](https://github.com/GLVis/glvis-js/blob/200a722811172bb070325163142dd84d8efaea25/live/index.html).
GLVis is Copyright (c) Lawrence Livermore National Security, LLC, under the
BSD-3-Clause license; `vendor/GLVIS-LICENSE` and `vendor/GLVIS-NOTICE` are bundled.
The new workstation HTML/CSS/JS uses the workstation's MIT license.

Mesh (`m`), axes (`a`), elements (`e`), resolution (`o`), palette (`P`/`p`),
material (`T`), lighting (`l`), colorbar (`c`), background (`g`), reset to 2D
(`R`) or 3D (`r`), perspective (`j`), zoom (`*`/`/`), stretch (`+`/`-`) and
spin (`.`) call the bundled `glvis.State.sendKey` API directly. Screenshot and
keyboard help use its `saveScreenshot` and `getHelpString` APIs. Button labels
do not claim a particular state because GLVis keys and commands can change it.

## Integration

Load `vis-controls.js` before `app.js`. After creating a `glvis.State`:

```js
const controls = GLVisControls.attach(viewer, {
  onError: message => notice(message),
  onPauseChange: paused => { /* optional status update */ },
  onStep: () => { /* release a guest stream paused at a GLVis pause command */ },
});

await controls.beforeFrame(); // before rendering each queued stream frame
await viewer.update(frame);
controls.setPaused(true);     // if a GLVis stream requests a pause
```

The first frame should render before calling `beforeFrame()`. `beforeFrame()`
waits while paused. Resume releases waiting frames; Step releases one frame.
`controls.paused` is a getter, `controls.step()` advances one frame while
paused, and `controls.destroy()` removes event listeners and releases waiters.
Pause holds incoming visualization frames. Socket backpressure can also make
the solver wait until frames resume.
Space toggles pause only while the GLVis canvas area has focus. Normal editor
and terminal input is not intercepted. GLVis is resized by the application's
existing ResizeObserver when its viewer enters or exits fullscreen.
