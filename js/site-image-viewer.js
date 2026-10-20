/* site-image-viewer.js — shared click-to-enlarge image viewer
   ------------------------------------------------------------
   One modal <dialog> per page, shared by every gallery surface:
   article photos (img.cursor-pointer) and linked screenshots
   (img[data-gallery-image], e.g. the Notion syllabus page).

   Progressive enhancement throughout:
     * images wrapped in an <a> keep their native full-res navigation
       until the dialog is proven usable — the click handler only
       intercepts after the feature check passes
     * bare images are upgraded into keyboard-reachable controls
       (role=button + Enter/Space) since there is no anchor to do it
     * no <dialog>/showModal support → return early, nothing bound
     * a duplicated <script> tag can never bind twice

   The dialog itself supplies focus containment, top-layer stacking and
   Escape-to-close; this script only paints the open/close transitions,
   the image/caption plumbing and the body scroll lock.
*/
(function () {
	"use strict";

	var IMAGE_SELECTOR = "img[data-gallery-image], img.cursor-pointer";

	var CLOSE_ICON =
		'<svg aria-hidden="true" width="16" height="16" ' +
		'viewBox="0 0 16 16" fill="none" ' +
		'xmlns="http://www.w3.org/2000/svg"><path d="M3 3l10 10M13 3L3 13" ' +
		'stroke="currentColor" stroke-width="1.5" ' +
		'stroke-linecap="round"/></svg>';

	function setupViewer() {
		var images = document.querySelectorAll(IMAGE_SELECTOR);
		if (!images.length) {
			return;
		}

		/* a second include of this file must not rebind everything */
		if (document.querySelector(".site-image-viewer")) {
			return;
		}

		/* Build the dialog first, then prove it can go modal — if not,
		   every trigger keeps its native behaviour untouched. */
		var dialog = document.createElement("dialog");
		if (typeof dialog.showModal !== "function") {
			return;
		}
		dialog.className = "site-image-viewer";
		dialog.setAttribute("aria-label", "Image viewer");

		var closeButton = document.createElement("button");
		closeButton.type = "button";
		closeButton.className = "site-image-viewer-close";
		closeButton.setAttribute("aria-label", "Close image viewer");
		closeButton.insertAdjacentHTML("beforeend", CLOSE_ICON);

		var content = document.createElement("div");
		content.className = "site-image-viewer-content";

		var enlarged = document.createElement("img");
		enlarged.className = "site-image-viewer-image";
		enlarged.alt = "";

		var status = document.createElement("p");
		status.className = "site-image-viewer-status";
		status.hidden = true;
		status.textContent = "This image could not be loaded.";

		var caption = document.createElement("p");
		caption.className = "site-image-viewer-caption";

		content.appendChild(enlarged);
		content.appendChild(status);
		content.appendChild(caption);
		dialog.appendChild(content);
		dialog.appendChild(closeButton);
		document.body.appendChild(dialog);

		var previousOverflow = "";
		var opener = null;

		enlarged.addEventListener("error", function () {
			status.hidden = false;
		});
		enlarged.addEventListener("load", function () {
			status.hidden = true;
		});

		/* Caption precedence: for gallery-flagged images, the visible
		   heading their section is already labelled by (resolved live
		   through aria-labelledby — reuses on-page text, never a
		   duplicated string); then an explicit data-gallery-caption;
		   then the figure's figcaption; then a sibling .image-caption;
		   then the alt text. The named-section step is gated on
		   data-gallery-image so article photos keep their old order.
		   textContent keeps every path inert markup-wise. */
		function captionFor(img) {
			var data = img.dataset || {};
			if ("galleryImage" in data) {
				var holder = img.closest("[aria-labelledby]");
				if (holder) {
					var ids = (
						holder.getAttribute("aria-labelledby") || ""
					).split(/\s+/);
					var named = [];
					for (var k = 0; k < ids.length; k++) {
						var el = ids[k] && document.getElementById(ids[k]);
						if (el && el.textContent) {
							named.push(el.textContent.trim());
						}
					}
					if (named.length) {
						return named.join(" ");
					}
				}
			}
			if (data.galleryCaption) {
				return data.galleryCaption;
			}
			var figure = img.closest("figure");
			if (figure) {
				var fc = figure.querySelector("figcaption");
				if (fc && fc.textContent) {
					return fc.textContent;
				}
			}
			var sib = img.parentElement && img.parentElement.nextElementSibling;
			if (
				sib &&
				sib.classList &&
				sib.classList.contains("image-caption")
			) {
				return sib.textContent;
			}
			return img.alt || "";
		}

		function openFor(img, trigger) {
			opener = trigger;
			previousOverflow = document.body.style.overflow;
			status.hidden = true; /* reset any stale error state */
			/* full-res override (gallery/anchor metadata), else whatever
			   the responsive pipeline already fetched */
			var data = img.dataset || {};
			enlarged.src = data.fullSrc || img.currentSrc || img.src;
			enlarged.alt = img.alt || "";
			caption.textContent = captionFor(img);
			dialog.showModal();
			document.body.style.overflow = "hidden";
		}

		/* Clicks that land on the dialog itself are the backdrop edge
		   (its padding covers the viewport) — content clicks carry a
		   different target and must not close. */
		dialog.addEventListener("click", function (e) {
			if (e.target === dialog) {
				dialog.close();
			}
		});
		closeButton.addEventListener("click", function () {
			dialog.close();
		});
		/* Native Escape handling fires the same close event, so scroll
		   and focus restoration live here — one path for every way
		   the dialog can be dismissed. */
		dialog.addEventListener("close", function () {
			document.body.style.overflow = previousOverflow;
			if (opener) {
				opener.focus();
				opener = null;
			}
		});

		for (var i = 0; i < images.length; i++) {
			(function (img) {
				var host = img.closest("a") || img;
				if (!img.closest("a, button")) {
					/* a bare image is not keyboard-reachable on its own —
					   give it the button contract before binding */
					img.setAttribute("role", "button");
					img.setAttribute("tabindex", "0");
					img.setAttribute(
						"aria-label",
						"Enlarge image: " + (img.alt || ""),
					);
					img.addEventListener("keydown", function (e) {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							openFor(img, img);
						}
					});
				}
				host.addEventListener("click", function (e) {
					e.preventDefault(); /* keep the dialog on-page */
					e.stopPropagation();
					openFor(img, host);
				});
			})(images[i]);
		}
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", setupViewer);
	} else {
		setupViewer();
	}
})();
