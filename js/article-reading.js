/* Article reading progress
   --------------------------------------------
   Thin fixed bar pinned to the top edge of article pages. The fill is
   a single scaleX transform — it tracks the article element's position
   exactly (not the document, so the footer never counts as "unread
   article"), updates once per animation frame, and has no inertia or
   transition of its own: it moves with the scroll.

   Lifecycle: one DOMContentLoaded init (defer already guarantees a
   parsed document; the readyState branch is just a fallback). A later
   image load, font swap, article resize, or pageshow-restore can change
   the article's measured box, so each of those schedules one extra
   update — no polling loop, no MutationObserver.
*/
(function () {
	"use strict";

	var ARTICLE_SELECTOR = ".article-content";
	var BAR_CLASS = "article-reading-progress";
	var FILL_CLASS = "article-reading-progress-fill";

	var article = null;
	var fill = null;
	var scheduled = false;

	function clamp01(value) {
		return Math.max(0, Math.min(1, value));
	}

	/* One layout read, one style write. */
	function update() {
		scheduled = false;
		if (!article || !fill) {
			return;
		}
		var rect = article.getBoundingClientRect();
		var range = rect.height - window.innerHeight;
		var ratio;
		if (range > 0) {
			/* Normal case: how far the article's top has scrolled past
               the viewport top, as a fraction of its scrollable span.
               0 while the article top is still below/on the top edge,
               1 exactly when its last pixel reaches the bottom edge. */
			ratio = clamp01(-rect.top / range);
		} else {
			/* Short article that never fills a viewport: count it as
               read once fully visible, unread before it appears. */
			ratio = rect.bottom <= window.innerHeight ? 1 : 0;
		}
		fill.style.transform = "scaleX(" + ratio + ")";
	}

	/* Coalesce bursts of scroll/resize events into a single frame. */
	function requestUpdate() {
		if (scheduled) {
			return;
		}
		scheduled = true;
		window.requestAnimationFrame(update);
	}

	/* Late-loading images change the article height — the capture
       listener catches load/error events that do not bubble. */
	function onMediaSettled(event) {
		if (event.target && event.target.tagName === "IMG") {
			requestUpdate();
		}
	}

	function init() {
		/* Never build a second bar if the script ran twice. */
		if (document.querySelector("." + BAR_CLASS)) {
			return;
		}
		/* Article pages resolve .article-content; other pages opt in by
           marking the measured element with data-reading-progress. */
		article =
			document.querySelector(ARTICLE_SELECTOR) ||
			document.querySelector("[data-reading-progress]");
		if (!article) {
			return;
		}

		var bar = document.createElement("div");
		bar.className = BAR_CLASS;
		/* Purely decorative — hidden from assistive tech so it does
           not announce constantly while scrolling. */
		bar.setAttribute("aria-hidden", "true");
		fill = document.createElement("span");
		fill.className = FILL_CLASS;
		bar.appendChild(fill);
		document.body.appendChild(bar);

		window.addEventListener("scroll", requestUpdate, { passive: true });
		window.addEventListener("resize", requestUpdate, { passive: true });
		/* Restored bfcache pages can reopen mid-article. */
		window.addEventListener("pageshow", requestUpdate);

		document.addEventListener("load", onMediaSettled, true);
		document.addEventListener("error", onMediaSettled, true);
		if (document.fonts && document.fonts.ready) {
			document.fonts.ready.then(requestUpdate);
		}
		if (window.ResizeObserver) {
			new window.ResizeObserver(requestUpdate).observe(article);
		}

		/* First paint — covers loads that restore a scroll position. */
		requestUpdate();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();
