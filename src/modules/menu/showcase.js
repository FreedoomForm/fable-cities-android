/**
 * Showcase for the menu module (§6b).
 *
 * The start screen normally runs BEFORE any module exists, so `?showcase=menu` is the only way to look
 * at it next to a built world. It shows the real screen — same backdrop, same seed preview, same help
 * card — in preview mode: picking a choice just dismisses the overlay instead of trying to boot a world
 * that has already booted.
 *
 *   http://127.0.0.1:5180/?showcase=menu            empty world behind the screen
 *   http://127.0.0.1:5180/?showcase=menu&demo=1     the demo city behind it
 */
export async function showcase(ctx) {
  const menu = await import('./index.js');

  window.__game.presets.menu_backdrop = { target: { x: -190, z: -240 }, distance: 1020, yaw: -0.26, pitch: 0.19 };

  // preview mode: resolve-and-dismiss, never enter the loading phase (the world is already up)
  const promise = menu.showStartScreen(ctx, { preview: true });
  promise.then((choice) => {
    if (ctx.config.debug) console.log('[menu/showcase] choice', choice);
  });
  // give the backdrop a beat to generate so a screenshot catches it, then leave the screen up
  await new Promise((r) => setTimeout(r, 1400));
}
