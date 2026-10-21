/* masthead-scene.js — decorative masthead motion, self-contained.
 *
 * Extracted from biwa-ride.js so the application controller only ever sees
 * BiwaMastheadScene.init(sceneElement). The figure GIFs (riders, walkers,
 * passers) are always animated by request; CSS can't pause a GIF's frames
 * so the figure imgs are simply hidden under prefers-reduced-motion. What
 * this module does is purely CSS-layer gating (.is-paused freezes every
 * animated belt/landmark/drift transform while the header is scrolled
 * offscreen or reduced motion is requested) plus a keep-alive nudge for
 * the GIFs themselves — browsers suspend decoding of animated images they
 * consider invisible, and walkers clipped deep inside the transformed
 * belt can come back frozen while their compositor-driven drift keeps
 * moving them. A per-figure IntersectionObserver re-assigns src on each
 * real entry, forcing the GIF to re-decode; the stride restart is
 * invisible at ~50px.
 */
(function (global) {
  'use strict';

  // One-time tree arrangement: the six traced assets (3 copies each =
  // 18 imgs) are Fisher-Yates shuffled, then scattered as 12 groups
  // (blueprint [1,2,1,1,3,1,2,1,2,1,2,1]) across the belt tile — group
  // bases at ~j/12 of the half plus 2-4% jitter (clamped inside the
  // edges), members spread 24-35px around the base. The computed tile is
  // cloned verbatim into the second half so the -50% wrap is seamless.
  // Runs at boot and again when the viewport width drifts — trip polls
  // never touch the masthead. Heights are NOT owned here — each img
  // keeps its HTML inline height (CSS clamps the range); JS only assigns
  // which asset fills each slot and how many slots the half needs.
  var SCENE_TREE_ASSETS = [
    'assets/tree-01.svg', 'assets/tree-02.svg', 'assets/tree-03.svg',
    'assets/tree-04.svg', 'assets/tree-05.svg', 'assets/tree-06.svg'
  ];
  // Target spacing between tree centres. Each belt half is
  // max(viewport, 900px) wide and positions are percentages, so a fixed
  // tree count would crowd together as the screen narrows — ~76px is
  // the original wide-desktop density (≈21 trees per 1600px) and
  // narrower halves simply get proportionally fewer trees to hold it.
  var SCENE_TREE_TARGET_GAP = 76;

  // Live handle — set by init, cleared by destroy. Module-level so a
  // second init() call is a cheap no-op, not a doubled listener set.
  var state = null;

  function arrangeSceneTrees() {
    var halves = state.scene
      ? state.scene.querySelectorAll('.biwa-scene-belt-half')
      : [];
    if (halves.length < 2) return;
    var half = halves[0];
    var halfWidth = half.getBoundingClientRect().width || 900;
    // Floor of 10 keeps even the narrowest half from going bare —
    // above that the count purely tracks width against the target gap.
    var treeCount = Math.max(10, Math.round(halfWidth / SCENE_TREE_TARGET_GAP));
    var imgs = half.querySelectorAll('.biwa-scene-tree');
    // Grow the img pool to the target count — clones inherit the class
    // and an authored src/height baseline; the layout below overwrites
    // position and src anyway, and generated heights randomise inside
    // the CSS-clamped band so they blend with the authored trees.
    var template = imgs[0];
    while (template && half.querySelectorAll('.biwa-scene-tree').length < treeCount) {
      var clone = template.cloneNode(false);
      clone.style.height = (70 + Math.round(Math.random() * 40)) + 'px';
      half.appendChild(clone);
    }
    imgs = half.querySelectorAll('.biwa-scene-tree');
    var assets = [];
    for (var i = 0; i < treeCount; i++) {
      assets.push(SCENE_TREE_ASSETS[i % SCENE_TREE_ASSETS.length]);
    }
    for (i = assets.length - 1; i > 0; i--) {
      var swap = Math.floor(Math.random() * (i + 1));
      var tmp = assets[i];
      assets[i] = assets[swap];
      assets[swap] = tmp;
    }
    // Grove sizes follow the authored mix — mostly singles and pairs
    // with the occasional trio — stretched to whatever count the half
    // needs. Bases spread evenly over 2–97% of the half's width.
    var groups = [];
    for (var remaining = treeCount; remaining > 0;) {
      var roll = Math.random();
      var g = remaining >= 3 ? (roll < 0.4 ? 1 : roll < 0.85 ? 2 : 3)
          : remaining === 2 ? (roll < 0.5 ? 1 : 2) : 1;
      groups.push(g);
      remaining -= g;
    }
    var cursor = 0;
    groups.forEach(function (count, gi) {
      var base = Math.min(97, Math.max(2,
        (gi / groups.length) * 95 + 2 + Math.random() * 2));
      var spread = 24 + Math.random() * 11;
      for (var k = 0; k < count && cursor < treeCount; k++, cursor++) {
        var img = imgs[cursor];
        img.setAttribute('src', assets[cursor]);
        img.style.setProperty('--tree-x', base + '%');
        var offset = count > 1 ? (k - (count - 1) / 2) * spread : 0;
        img.style.setProperty('--tree-offset', offset.toFixed(1) + 'px');
        img.style.display = '';
      }
    });
    // Authored imgs beyond the needed count hide rather than being
    // deleted — a later narrower arrangement can re-show them.
    for (var x = cursor; x < imgs.length; x++) imgs[x].style.display = 'none';
    halves[1].innerHTML = half.innerHTML;
  }

  function sceneMotionAllowed() {
    return state.visible && !(state.motionQuery && state.motionQuery.matches);
  }

  function applySceneMotion() {
    if (!state.scene) return;
    state.scene.classList.toggle('is-paused', !sceneMotionAllowed());
  }

  // Figure GIF keep-alive — rooted on the scene so entries fire only
  // when a figure actually crosses into the visible masthead (the
  // 100px margin pre-wakes decode just before it appears). WebKit
  // suspends GIF decode for never-painted images and only re-checks
  // on scroll/repaint — the belt's transform drifts walkers in with
  // neither — so a src self-assign is useless (the in-memory cache
  // returns the same suspended animation). A display flick forces the
  // renderer to detach and rebuild while in view, which runs the
  // real resume path. Cloned belt imgs are re-observed after each
  // re-arrangement; a per-img cooldown stops clip-boundary flicker
  // from re-triggering.
  function observeSceneFigures() {
    if (!('IntersectionObserver' in global) || !state.scene) return;
    if (!state.figureIO) {
      state.figureIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          var img = entry.target;
          if (!entry.isIntersecting) return;
          var now = Date.now();
          if (now - (img._biwaGifNudge || 0) < 1500) return;
          img._biwaGifNudge = now;
          img.style.display = 'none';
          void img.offsetHeight;   // force the detach+rebuild while visible
          img.style.display = '';
        });
      }, { root: state.scene, rootMargin: '100px' });
    }
    Array.prototype.slice.call(
      state.scene.querySelectorAll(
        '.biwa-scene-walker, .biwa-scene-passer, .biwa-scene-rider'))
      .forEach(function (img) { state.figureIO.observe(img); });
  }

  function onResize() {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(function () {
      var half = state.scene &&
        state.scene.querySelector('.biwa-scene-belt-half');
      if (!half) return;
      var width = half.getBoundingClientRect().width;
      if (Math.abs(width - state.halfWidth) < 60) return;
      state.halfWidth = width;
      arrangeSceneTrees();
      observeSceneFigures();
      applySceneMotion();
    }, 200);
  }

  // Boot the scene. Idempotent: re-init with the SAME element is a no-op;
  // init with a different element tears the old wiring down first so a
  // re-mounted masthead can never double-observe or double-listen.
  // Returns the live handle, or null when there is no scene to drive.
  function init(sceneElement) {
    if (!sceneElement) return null;
    if (state && state.scene === sceneElement) return state.handle;
    if (state) destroy();

    state = {
      scene: sceneElement,
      motionQuery: global.matchMedia
        ? global.matchMedia('(prefers-reduced-motion: reduce)') : null,
      visible: true,
      halfWidth: 0,
      resizeTimer: null,
      figureIO: null,
      sceneIO: null
    };
    state.onResize = onResize;
    state.onMotionChange = applySceneMotion;

    arrangeSceneTrees();
    // The half width is viewport-derived — a rotation or window resize
    // changes the needed tree count, so re-arrange once it drifts. The
    // belt clone (walkers included) is rebuilt inside arrangeSceneTrees().
    var sceneTreeHalf = sceneElement.querySelector('.biwa-scene-belt-half');
    state.halfWidth = sceneTreeHalf ? sceneTreeHalf.getBoundingClientRect().width : 0;
    global.addEventListener('resize', onResize);

    if (state.motionQuery && state.motionQuery.addEventListener) {
      // A system-level change to reduced motion re-applies instantly.
      state.motionQuery.addEventListener('change', applySceneMotion);
    }
    if ('IntersectionObserver' in global) {
      // Offscreen: freeze the CSS layers so a scrolled-past header costs
      // no animation work. The figure GIFs keep decoding — frames can't
      // be paused — but they stay clipped out of frame.
      state.sceneIO = new IntersectionObserver(function (entries) {
        state.visible = entries[0].isIntersecting;
        applySceneMotion();
      });
      state.sceneIO.observe(sceneElement);
    }
    applySceneMotion();
    observeSceneFigures();

    state.handle = { destroy: destroy };
    return state.handle;
  }

  // Cleanup seam — disconnects every observer and listener the module
  // installed. Nothing else in the app calls this today; it exists so the
  // scene can be torn down without leaking.
  function destroy() {
    if (!state) return;
    clearTimeout(state.resizeTimer);
    if (state.sceneIO) state.sceneIO.disconnect();
    if (state.figureIO) state.figureIO.disconnect();
    if (state.motionQuery && state.motionQuery.removeEventListener) {
      state.motionQuery.removeEventListener('change', applySceneMotion);
    }
    if (global.removeEventListener) {
      global.removeEventListener('resize', onResize);
    }
    state = null;
  }

  var api = { init: init, destroy: destroy };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BiwaMastheadScene = api;
})(typeof window !== 'undefined' ? window : globalThis);
