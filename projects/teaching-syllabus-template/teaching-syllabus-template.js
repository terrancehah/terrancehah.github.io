/* Teaching syllabus template — page script
   --------------------------------------------
   Two independent progressive-enhancement modules; each fails open so
   a missing API or a setup error can never hide content:

   1. FAQ drawers — the markup ships every .syllabus-faq-panel open.
      This injects a real <button> into each question heading
      (aria-expanded + aria-controls + an aria-hidden inline chevron),
      then collapses the panels. Toggles are a synchronous class + ARIA
      sync with no timers, so rapid clicks can never desync, and each
      drawer is independent. Panels are never hidden/display:none — the
      grid-rows 0fr↔1fr transition needs them painted.
   2. Screenshot reveals — an IntersectionObserver toggles .is-visible
      on each .syllabus-screenshot (threshold 0, a -24px bottom margin
      that pulls the trigger edge 24px inside the viewport, so an image
      only counts once it is genuinely on screen). <html> only gets
      .syllabus-reveals-enabled after every image is being observed —
      without it the hidden-state rule can never apply. Skipped under
      prefers-reduced-motion; a live change to reduce tears the
      observer down and shows everything.
*/
(function () {
	"use strict";

	/* ---------- FAQ drawers ---------- */
	function setupFaq() {
		var items = document.querySelectorAll(".syllabus-faq-item");
		var CHEVRON =
			'<svg class="syllabus-faq-chevron" aria-hidden="true" ' +
			'width="16" height="16" viewBox="0 0 16 16" fill="none" ' +
			'xmlns="http://www.w3.org/2000/svg"><path d="M4 6l4 4 4-4" ' +
			'stroke="currentColor" stroke-width="1.5" ' +
			'stroke-linecap="round" stroke-linejoin="round"/></svg>';
		var drawers = [];
		var i;

		/* Pass 1 — build every toggle first. If anything throws here,
           the panels are still open exactly as the markup shipped. */
		for (i = 0; i < items.length; i++) {
			var question = items[i].querySelector(".syllabus-faq-question");
			var panel = items[i].querySelector(".syllabus-faq-panel");
			if (!question || !panel) {
				continue;
			}
			if (!panel.id) {
				panel.id = "syllabus-faq-panel-" + (i + 1);
			}
			var button = document.createElement("button");
			button.type = "button";
			button.className = "syllabus-faq-toggle";
			button.setAttribute("aria-expanded", "true");
			button.setAttribute("aria-controls", panel.id);
			button.textContent = question.textContent;
			button.insertAdjacentHTML("beforeend", CHEVRON);
			question.textContent = "";
			question.appendChild(button);
			drawers.push({ button: button, panel: panel });
		}

		/* Pass 2 — everything bound, now collapse to the closed state
           and wire the synchronous toggle. */
		for (i = 0; i < drawers.length; i++) {
			(function (drawer) {
				var button = drawer.button;
				var panel = drawer.panel;

				function setOpen(open) {
					/* Closing while focus sits inside the panel would
                       strand it — hand it back to the trigger BEFORE
                       inert/aria-hidden land: marking the panel inert
                       blurs a focused descendant, and once blurred the
                       contains(activeElement) signal is gone. */
					if (!open && panel.contains(document.activeElement)) {
						button.focus();
					}
					panel.classList.toggle("is-open", open);
					button.setAttribute(
						"aria-expanded",
						open ? "true" : "false",
					);
					panel.inert = !open;
					if (open) {
						panel.removeAttribute("aria-hidden");
					} else {
						panel.setAttribute("aria-hidden", "true");
					}
				}

				setOpen(false);
				button.addEventListener("click", function () {
					setOpen(!panel.classList.contains("is-open"));
				});
			})(drawers[i]);
		}
	}

	/* ---------- screenshot reveals ---------- */
	function setupReveals() {
		var shots = document.querySelectorAll(".syllabus-screenshot");
		if (!shots.length || !window.matchMedia) {
			return;
		}
		var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
		var root = document.documentElement;
		var observer = null;

		function showAll() {
			root.classList.remove("syllabus-reveals-enabled");
			for (var i = 0; i < shots.length; i++) {
				shots[i].classList.add("is-visible");
			}
		}

		function init() {
			if (!window.IntersectionObserver || mq.matches) {
				return;
			}
			try {
				observer = new window.IntersectionObserver(
					function (entries) {
						for (var i = 0; i < entries.length; i++) {
							entries[i].target.classList.toggle(
								"is-visible",
								entries[i].isIntersecting,
							);
						}
					},
					{ threshold: 0, rootMargin: "0px 0px -24px 0px" },
				);
				/* observe everything BEFORE enabling the hidden state —
                   an image we failed to observe would stay invisible */
				for (var j = 0; j < shots.length; j++) {
					observer.observe(shots[j]);
				}
				root.classList.add("syllabus-reveals-enabled");
			} catch (err) {
				if (observer) {
					observer.disconnect();
					observer = null;
				}
				showAll();
			}
		}

		function teardown() {
			if (observer) {
				observer.disconnect();
				observer = null;
			}
			showAll();
		}

		init();
		/* a live OS-level change re-arms or tears down the observer */
		var onChange = function () {
			if (mq.matches) {
				teardown();
			} else {
				init();
			}
		};
		if (mq.addEventListener) {
			mq.addEventListener("change", onChange);
		} else if (mq.addListener) {
			mq.addListener(onChange); /* legacy Safari */
		}
	}

	function initAll() {
		try {
			setupFaq();
		} catch (err) {
			/* fail open — put every panel back to its shipped state,
			   and any injected toggles back to expanded so nothing is
			   left collapsed behind a mid-setup failure */
			var panels = document.querySelectorAll(".syllabus-faq-panel");
			var i;
			for (i = 0; i < panels.length; i++) {
				panels[i].classList.add("is-open");
				panels[i].inert = false;
				panels[i].removeAttribute("aria-hidden");
			}
			var toggles = document.querySelectorAll(".syllabus-faq-toggle");
			for (i = 0; i < toggles.length; i++) {
				toggles[i].setAttribute("aria-expanded", "true");
			}
		}
		try {
			setupReveals();
		} catch (err) {
			document.documentElement.classList.remove(
				"syllabus-reveals-enabled",
			);
		}
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", initAll);
	} else {
		initAll();
	}
})();
