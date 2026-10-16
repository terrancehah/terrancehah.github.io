// Running Posture Analyser - front-end scaffold.
// For now this handles photo selection, validation, previews, and renders a
// TEMPLATE results dashboard. AI analysis, photo overlays, and export are
// intentionally not wired up yet.

document.addEventListener("DOMContentLoaded", function () {
	// Base path for the four gait-phase illustrations (saved by the user).
	const PHASE_IMG = "/resources/projects/running-posture-analyser/";

	const DEFAULT_NOTE =
		"This is a layout preview. AI analysis is not connected yet \u2014 the summary and each element below show where the observations will appear.";
	const DEMO_NOTE =
		"Sample output to show the intended layout. Observations and measurements are illustrative only \u2014 real AI analysis is not connected yet.";

	// Whole-stride summary shown above the individual element cards.
	const overall = {
		demo: "Running posture is generally upright with good hip extension and compact arm swing. The clearest opportunity is foot strike — the foot lands ahead of the hips on every step, which creates a small braking effect that reduces efficiency. Head position is slightly forward of neutral, but overall whole-body alignment is a positive foundation to build on.",
	};

	// Six analysis elements ordered top-down by body region (head → torso → arms → hips → knees → feet).
	// Each carries a qualitative status shown in demo mode: 'good', 'fair', or 'attention'.
	const elements = [
		{
			name: "Head & Neck Alignment",
			status: "fair",
			image: "full-contact.png",
			demo: "The head sits slightly forward of the shoulders, producing a small degree of forward head posture. This is common in recreational runners and adds subtle strain to the neck and upper back \u2014 especially noticeable over longer distances.",
			insights: [
				{
					title: "Head carriage",
					chip: "Slightly forward",
					text: "The chin is a little ahead of the collar line. Drawing the chin back slightly and relaxing the jaw would help realign the head over the shoulders.",
				},
				{
					title: "Gaze direction",
					chip: "Roughly level",
					text: "Eyes appear directed forward and level \u2014 correct. Avoid the habit of looking down at the ground ahead of the feet.",
				},
			],
		},
		{
			name: "Overall Posture & Torso Lean",
			status: "good",
			image: "full-contact.png",
			demo: "Posture is generally upright and controlled. There is a small, consistent forward lean that originates from the ankles rather than the waist \u2014 the more efficient pattern for generating forward momentum without collapsing the torso.",
			insights: [
				{
					title: "Trunk lean",
					chip: "Slight & controlled",
					text: "The lean originates at the ankle, keeping the torso elongated rather than bent at the waist.",
				},
				{
					title: "Torso stability",
					chip: "Stable",
					text: "Minimal side-to-side sway is visible across the frames \u2014 a positive sign for stride efficiency.",
				},
			],
		},
		{
			name: "Arm Swing Mechanics",
			status: "good",
			image: "toe-off.png",
			demo: "The arms swing compactly with elbows held at roughly 90\u00b0. There is minimal crossing of the body\u2019s midline, and the backward arm drive at push-off is well-timed with the leg \u2014 a good counterbalancing pattern that keeps the torso relaxed.",
			insights: [
				{
					title: "Elbow angle",
					chip: "Near 90\u00b0",
					text: "Elbows remain bent and held close to the body \u2014 the correct range for efficient forward propulsion.",
				},
				{
					title: "Midline crossing",
					chip: "Minimal",
					text: "Arms swing predominantly forward and back with very little horizontal crossing, helping prevent unnecessary torso rotation.",
				},
			],
		},
		{
			name: "Hip Extension at Toe-Off",
			status: "good",
			image: "toe-off.png",
			demo: "At push-off, the trailing hip opens well behind the torso, showing the glutes are contributing effectively to propulsion. This is one of the most important drivers of running economy and is well-executed here.",
			insights: [
				{
					title: "Hip opening",
					chip: "Strong extension",
					text: "The trailing thigh clears past vertical at toe-off, showing the hip is fully engaged and driving through at push-off.",
				},
				{
					title: "Ankle drive",
					chip: "Present",
					text: "Some ankle extension is visible at toe-off, adding to the propulsive force generated at each step.",
				},
			],
		},
		{
			name: "Knee Drive in Swing Phase",
			status: "good",
			image: "swing.png",
			demo: "Knee drive is active and the thigh reaches a useful height during the recovery swing. The heel is drawn up compactly after toe-off, keeping the swing leg fast and reducing the effort needed to bring it forward.",
			insights: [
				{
					title: "Thigh lift",
					chip: "Active drive",
					text: "The knee lifts forward to a good height \u2014 enough to allow stride length to develop without reaching forward at landing.",
				},
				{
					title: "Heel recovery",
					chip: "Compact",
					text: "The heel rises quickly toward the buttocks on the way through, reducing swing-leg inertia and speeding up the stride cycle.",
				},
			],
		},
		{
			name: "Foot Strike & Overstriding",
			status: "attention",
			image: "initial-contact.png",
			demo: "The lead foot contacts the ground noticeably ahead of the body\u2019s centre of mass, with the knee fairly extended at impact. This pattern \u2014 often called overstriding \u2014 creates a braking force at each step and increases stress on the knee and hip.",
			insights: [
				{
					title: "Landing position",
					chip: "Ahead of hips",
					text: "The foot contacts the ground in front of the centre of mass rather than beneath the hips \u2014 the primary sign of overstriding.",
				},
				{
					title: "Foot strike type",
					chip: "Heel-first contact",
					text: "Contact appears heel-first with the toes lifted, which amplifies the braking force felt through the lower limb at each impact.",
				},
			],
		},
	];

	// Cache DOM references used across the handlers.
	const fileInput = document.getElementById("rpa-file-input");
	const dropzone = document.getElementById("rpa-dropzone");
	const previewGrid = document.getElementById("rpa-preview-grid");
	const fileCount = document.getElementById("rpa-file-count");
	const analyseBtn = document.getElementById("rpa-analyse-btn");
	const clearBtn = document.getElementById("rpa-clear-btn");
	const resultsSection = document.getElementById("rpa-results");
	const overallEl = document.getElementById("rpa-overall");
	const phaseStack = document.getElementById("rpa-phase-stack");
	const profileRecap = document.getElementById("rpa-profile-recap");
	const demoBtn = document.getElementById("rpa-demo-btn");
	const demoBadge = document.getElementById("rpa-demo-badge");
	const resultsNote = document.getElementById("rpa-results-note");
	const loaderOverlay = document.getElementById("rpa-loading-overlay");
	const loaderPrompt = document.getElementById("rpa-loading-prompt");
	const newAnalysisBtn = document.getElementById("rpa-new-analysis-btn");
	const photoStrip = document.getElementById("rpa-photo-strip");
	const scoreSummary = document.getElementById("rpa-score-summary");

	// Holds the currently selected image files. We keep our own array because
	// the native FileList is read-only and we want to support per-item removal.
	let selectedFiles = [];

	// Latest snapshot of the runner profile inputs (captured when analysis runs).
	let runnerProfile = {};

	// ----- Loading overlay -----

	// Rotating prompts shown in the loading card while the API call is in flight.
	const LOADER_PROMPTS = [
		"Examining your running form…",
		"Analysing foot strike and cadence patterns…",
		"Reviewing upper body and arm mechanics…",
		"Checking hip extension and knee drive…",
		"Compiling your personalised report…",
	];

	let loaderInterval = null;

	function startLoader() {
		var idx = 0;
		loaderPrompt.textContent = LOADER_PROMPTS[0];
		loaderOverlay.hidden = false;
		loaderInterval = setInterval(function () {
			idx = (idx + 1) % LOADER_PROMPTS.length;
			loaderPrompt.textContent = LOADER_PROMPTS[idx];
		}, 5000);
	}

	function stopLoader() {
		clearInterval(loaderInterval);
		loaderInterval = null;
		loaderOverlay.hidden = true;
	}

	// ----- Image viewer -----

	// Overlay created once and reused for every photo click — matches the articles pattern.
	var imgViewerOverlay = document.createElement("div");
	imgViewerOverlay.className = "rpa-img-viewer-overlay";
	imgViewerOverlay.setAttribute("hidden", "");

	var imgViewerImg = document.createElement("img");
	imgViewerImg.className = "rpa-img-viewer-img";

	var imgViewerCaption = document.createElement("p");
	imgViewerCaption.className = "rpa-img-viewer-caption";

	var imgViewerClose = document.createElement("button");
	imgViewerClose.className = "rpa-img-viewer-close";
	imgViewerClose.innerHTML = "&times;";
	imgViewerClose.setAttribute("aria-label", "Close image viewer");
	imgViewerClose.setAttribute("type", "button");

	imgViewerOverlay.appendChild(imgViewerImg);
	imgViewerOverlay.appendChild(imgViewerCaption);
	imgViewerOverlay.appendChild(imgViewerClose);
	document.body.appendChild(imgViewerOverlay);

	function openImageViewer(src, captionText) {
		imgViewerImg.src = src;
		imgViewerCaption.textContent = captionText || "";
		imgViewerOverlay.removeAttribute("hidden");
		document.body.style.overflow = "hidden";
	}

	function closeImageViewer() {
		imgViewerOverlay.setAttribute("hidden", "");
		document.body.style.overflow = "";
	}

	imgViewerClose.addEventListener("click", function (e) {
		e.stopPropagation();
		closeImageViewer();
	});
	imgViewerOverlay.addEventListener("click", function (e) {
		if (e.target === imgViewerOverlay) {
			closeImageViewer();
		}
	});
	document.addEventListener("keydown", function (e) {
		if (e.key === "Escape" && !imgViewerOverlay.hasAttribute("hidden")) {
			closeImageViewer();
		}
	});

	// ----- Photo strip -----

	// Renders the submitted photos as a read-only horizontal strip in the results section.
	// Each photo is clickable and opens the image viewer overlay.
	function renderPhotoStrip(photoUrls) {
		if (!photoStrip || !photoUrls.length) {
			return;
		}
		photoStrip.innerHTML = "";
		photoUrls.forEach(function (url, i) {
			var item = document.createElement("div");
			item.className = "rpa-photo-strip-item";
			var img = document.createElement("img");
			img.src = url;
			img.alt = "Submitted running photo " + (i + 1);
			// Open image viewer when the thumbnail is clicked.
			img.addEventListener("click", function () {
				openImageViewer(
					url,
					"Photo " + (i + 1) + " of " + photoUrls.length,
				);
			});
			item.appendChild(img);
			photoStrip.appendChild(item);
		});
		photoStrip.hidden = false;
	}

	// ----- Helpers -----

	// All seven profile fields must have a non-empty value before analysis can run.
	const REQUIRED_PROFILE_FIELDS = [
		"rpa-height-cm",
		"rpa-weight-kg",
		"rpa-age",
		"rpa-gender",
		"rpa-volume",
		"rpa-pace-min",
		"rpa-pace-sec",
	];

	function isProfileComplete() {
		return REQUIRED_PROFILE_FIELDS.every(function (id) {
			const el = document.getElementById(id);
			return el && el.value.trim() !== "";
		});
	}

	// Keep the UI (count text, buttons, previews) in sync with selectedFiles and profile state.
	function refreshUi() {
		const count = selectedFiles.length;
		const profileOk = isProfileComplete();
		const readyToAnalyse = count > 0 && profileOk;

		if (count === 0) {
			fileCount.textContent = "No photos selected";
		} else if (!profileOk) {
			fileCount.textContent =
				count +
				(count === 1 ? " photo" : " photos") +
				" selected — fill in your profile above to continue";
		} else {
			fileCount.textContent =
				count + (count === 1 ? " photo selected" : " photos selected");
		}

		analyseBtn.disabled = !readyToAnalyse;
		clearBtn.hidden = count === 0;
		renderPreviews();
	}

	// Render a thumbnail (with a remove button) for each selected file.
	function renderPreviews() {
		previewGrid.innerHTML = "";

		selectedFiles.forEach(function (file, index) {
			const item = document.createElement("div");
			item.className = "rpa-preview-item";

			const img = document.createElement("img");
			img.alt = "Selected running photo " + (index + 1);
			// Object URLs avoid reading the whole file into a data string.
			img.src = URL.createObjectURL(file);
			// Free the object URL once the browser has loaded the image.
			img.onload = function () {
				URL.revokeObjectURL(img.src);
			};

			const removeBtn = document.createElement("button");
			removeBtn.type = "button";
			removeBtn.className = "rpa-preview-remove";
			removeBtn.setAttribute("aria-label", "Remove photo " + (index + 1));
			removeBtn.innerHTML = "&times;";
			removeBtn.addEventListener("click", function () {
				selectedFiles.splice(index, 1);
				refreshUi();
			});

			item.appendChild(img);
			item.appendChild(removeBtn);
			previewGrid.appendChild(item);
		});
	}

	// Accept only image files; silently ignore anything else.
	function addFiles(fileList) {
		const incoming = Array.from(fileList).filter(function (file) {
			return file.type.startsWith("image/");
		});
		selectedFiles = selectedFiles.concat(incoming);
		refreshUi();
	}

	// Render the overall posture summary.
	// Pass a text string for demo/AI mode, or null to show the pending placeholder.
	function renderOverall(text) {
		const summaryClass = text
			? "rpa-overall-summary"
			: "rpa-overall-summary rpa-pending";
		const summaryText =
			text ||
			"A short summary of your running posture will appear here once analysis runs.";
		overallEl.innerHTML =
			'<p class="rpa-overall-label">Overall posture</p>' +
			'<p class="' +
			summaryClass +
			'">' +
			summaryText +
			"</p>";
	}

	// Status labels and their CSS modifier suffixes.
	const STATUS_LABELS = {
		good: "Good",
		fair: "Fair",
		attention: "Needs attention",
	};

	// Render element cards from a data array.
	// opts.showBadges  — show status badges and chip labels (true for demo and AI results)
	// opts.showMedia   — show the static reference image alongside the card (true for demo/template only)
	function renderElements(data, opts) {
		phaseStack.innerHTML = "";
		const showBadges = opts && opts.showBadges;
		const showMedia = opts && opts.showMedia;
		const animate = opts && opts.animate;

		data.forEach(function (element, index) {
			const panel = document.createElement("article");
			// AI results have no media column; mark the panel so CSS can give full width to the body.
			panel.className = showMedia
				? "rpa-phase-panel"
				: "rpa-phase-panel rpa-phase-panel--no-media";
			// Staggered fade-up entrance only for live AI results.
			if (animate) {
				panel.classList.add("rpa-panel-enter");
				panel.style.animationDelay = index * 0.07 + "s";
			}

			// Per-insight rows (title + qualitative chip + supporting text).
			let insightRows = "";
			(element.insights || []).forEach(function (insight) {
				const chipHtml =
					showBadges && insight.chip
						? '<span class="rpa-chip">' + insight.chip + "</span>"
						: "";
				const insightText = showBadges
					? insight.text || ""
					: "Observation pending analysis.";
				insightRows +=
					'<li class="rpa-insight-row">' +
					'<div class="rpa-insight-head">' +
					'<span class="rpa-insight-title">' +
					insight.title +
					"</span>" +
					chipHtml +
					"</div>" +
					'<p class="rpa-insight-text">' +
					insightText +
					"</p>" +
					"</li>";
			});

			// Observation text: AI mode uses element.observation, demo uses element.demo.
			const obsText = showBadges
				? element.observation || element.demo || ""
				: "";
			const obsClass = obsText
				? "rpa-phase-observation"
				: "rpa-phase-observation rpa-pending";
			const obsDisplay =
				obsText ||
				"Observations for this element will appear here once analysis runs.";

			// Status badge only when we have real data to show.
			const statusHtml =
				showBadges && element.status
					? '<span class="rpa-status-badge rpa-status-badge--' +
						element.status +
						'">' +
						STATUS_LABELS[element.status] +
						"</span>"
					: "";

			// Static reference image only in demo/template mode.
			const mediaHtml =
				showMedia && element.image
					? '<div class="rpa-phase-panel-media"><img src="' +
						PHASE_IMG +
						element.image +
						'" alt="' +
						element.name +
						' illustration" loading="lazy"></div>'
					: "";

			panel.innerHTML =
				mediaHtml +
				'<div class="rpa-phase-panel-body">' +
				'<div class="rpa-element-header">' +
				'<h4 class="rpa-phase-name">' +
				element.name +
				"</h4>" +
				statusHtml +
				"</div>" +
				'<p class="' +
				obsClass +
				'">' +
				obsDisplay +
				"</p>" +
				'<ul class="rpa-insight">' +
				insightRows +
				"</ul>" +
				"</div>";

			phaseStack.appendChild(panel);
		});
	}

	// Sample profile shown alongside the demo dashboard.
	const DEMO_PROFILE = {
		units: "metric",
		height: { units: "cm", cm: "176" },
		weight: { units: "kg", value: "70" },
		age: "32",
		gender: "male",
		monthlyVolume: { value: "120", unit: "km" },
		pace: { value: "5:20", unit: "km" },
	};

	// Human-readable labels for the goal codes.
	const GOAL_LABELS = {
		fitness: "General fitness",
		faster: "Run faster",
		race: "Train for a race",
		injury: "Return from injury",
		form: "Improve form",
	};

	// Capitalise the first letter of a string.
	function capitalize(str) {
		return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
	}

	// Turn a profile object into [{ label, value }] pairs, skipping blank fields.
	function profileToItems(p) {
		const items = [];
		if (!p) {
			return items;
		}

		if (p.height) {
			if (p.height.units === "cm" && p.height.cm) {
				items.push({ label: "Height", value: p.height.cm + " cm" });
			} else if (
				p.height.units === "ft-in" &&
				(p.height.ft || p.height.in)
			) {
				items.push({
					label: "Height",
					value:
						(p.height.ft || "0") +
						"\u2032 " +
						(p.height.in || "0") +
						"\u2033",
				});
			}
		}
		if (p.weight && p.weight.value) {
			items.push({
				label: "Weight",
				value: p.weight.value + " " + p.weight.units,
			});
		}
		if (p.age) {
			items.push({ label: "Age", value: p.age + " yrs" });
		}
		if (p.gender) {
			items.push({ label: "Gender", value: capitalize(p.gender) });
		}
		if (p.experience) {
			items.push({
				label: "Experience",
				value: capitalize(p.experience),
			});
		}
		if (p.monthlyVolume && p.monthlyVolume.value) {
			items.push({
				label: "Monthly volume",
				value: p.monthlyVolume.value + " " + p.monthlyVolume.unit,
			});
		}
		if (p.pace && p.pace.value) {
			items.push({
				label: "Pace",
				value: p.pace.value + " /" + p.pace.unit,
			});
		}
		if (p.goal) {
			let goalText = GOAL_LABELS[p.goal] || p.goal;
			if (p.goal === "race" && p.raceDistance) {
				goalText +=
					" (" +
					p.raceDistance.toUpperCase() +
					(p.raceDate ? ", " + p.raceDate : "") +
					")";
			}
			items.push({ label: "Goal", value: goalText });
		}
		return items;
	}

	// Render the captured profile as a row of labelled chips above the results.
	function renderProfileRecap(isDemo) {
		if (!profileRecap) {
			return;
		}
		const items = profileToItems(isDemo ? DEMO_PROFILE : runnerProfile);

		if (items.length === 0) {
			profileRecap.innerHTML =
				'<p class="rpa-recap-empty">No profile details added \u2014 fill in “Your running profile” above to tailor the analysis.</p>';
			return;
		}

		let chips = "";
		items.forEach(function (item) {
			chips +=
				'<span class="rpa-recap-chip"><span class="rpa-recap-key">' +
				item.label +
				"</span>" +
				item.value +
				"</span>";
		});
		profileRecap.innerHTML =
			'<p class="rpa-recap-label">Your details</p>' +
			'<div class="rpa-recap-chips">' +
			chips +
			"</div>";
	}

	// Builds the at-a-glance coloured-dot tally shown above the profile chips.
	function renderScoreSummary(elementsData) {
		if (!scoreSummary || !elementsData) {
			return;
		}
		var counts = { good: 0, fair: 0, attention: 0 };
		elementsData.forEach(function (el) {
			var s = (el.status || "").toLowerCase();
			if (Object.prototype.hasOwnProperty.call(counts, s)) {
				counts[s]++;
			}
		});
		scoreSummary.innerHTML =
			'<span class="rpa-score-item rpa-score-good">' +
			'<span class="rpa-score-dot"></span>' +
			counts.good +
			" Good" +
			"</span>" +
			'<span class="rpa-score-sep">&middot;</span>' +
			'<span class="rpa-score-item rpa-score-fair">' +
			'<span class="rpa-score-dot"></span>' +
			counts.fair +
			" Fair" +
			"</span>" +
			'<span class="rpa-score-sep">&middot;</span>' +
			'<span class="rpa-score-item rpa-score-attention">' +
			'<span class="rpa-score-dot"></span>' +
			counts.attention +
			" Needs attention" +
			"</span>";
		scoreSummary.hidden = false;
	}

	// Render the full results dashboard.
	// mode: 'demo'     — static demo data, badges and reference images shown
	//       'template' — layout preview, placeholder text, reference images shown
	//       'ai'       — live AI data, badges shown, no reference images
	function renderResults(mode, aiData) {
		renderProfileRecap(mode === "demo");
		if (mode === "ai") {
			renderScoreSummary(aiData.elements);
			renderOverall(aiData.overall);
			renderElements(aiData.elements, {
				showBadges: true,
				showMedia: false,
				animate: true,
			});
		} else if (mode === "demo") {
			renderScoreSummary(elements);
			renderOverall(overall.demo);
			renderElements(elements, {
				showBadges: true,
				showMedia: true,
				animate: false,
			});
		} else {
			// template / pending
			scoreSummary.hidden = true;
			renderOverall(null);
			renderElements(elements, {
				showBadges: false,
				showMedia: true,
				animate: false,
			});
		}
	}

	// ----- Runner profile interactions -----

	// Metric/imperial toggle: show only the height/weight fields for the chosen system.
	function setUnits(units) {
		document.querySelectorAll(".rpa-unit-btn").forEach(function (btn) {
			btn.classList.toggle("is-active", btn.dataset.units === units);
		});
		document
			.querySelectorAll("[data-unit-field]")
			.forEach(function (field) {
				field.hidden = field.dataset.unitField !== units;
			});
	}

	document.querySelectorAll(".rpa-unit-btn").forEach(function (btn) {
		btn.addEventListener("click", function () {
			setUnits(btn.dataset.units);
		});
	});

	// Experience: single-select segmented control (clicking the active one clears it).
	// Guarded so the page still works if this group is removed/commented out.
	const experienceGroup = document.getElementById("rpa-experience");
	if (experienceGroup) {
		experienceGroup.addEventListener("click", function (event) {
			const btn = event.target.closest(".rpa-segment-btn");
			if (!btn) {
				return;
			}
			const wasActive = btn.classList.contains("is-active");
			experienceGroup
				.querySelectorAll(".rpa-segment-btn")
				.forEach(function (b) {
					b.classList.remove("is-active");
				});
			if (!wasActive) {
				btn.classList.add("is-active");
			}
		});
	}

	// Goal: reveal race distance + target date only when "Train for a race" is chosen.
	const goalSelect = document.getElementById("rpa-goal");
	const raceDistanceField = document.getElementById(
		"rpa-race-distance-field",
	);
	const raceDateField = document.getElementById("rpa-race-date-field");
	if (goalSelect && raceDistanceField && raceDateField) {
		goalSelect.addEventListener("change", function () {
			const isRace = goalSelect.value === "race";
			raceDistanceField.hidden = !isRace;
			raceDateField.hidden = !isRace;
		});
	}

	// Collect every profile input into a plain object for the (future) AI step.
	function getProfile() {
		const activeUnit = document.querySelector(".rpa-unit-btn.is-active");
		const units = activeUnit ? activeUnit.dataset.units : "metric";
		const activeExp = document.querySelector(".rpa-segment-btn.is-active");
		// Small helper to read a trimmed value by element id (null-safe so that
		// commented-out / removed fields cannot throw).
		const val = function (id) {
			const el = document.getElementById(id);
			return el ? (el.value || "").trim() : "";
		};

		const height =
			units === "metric"
				? { units: "cm", cm: val("rpa-height-cm") }
				: {
						units: "ft-in",
						ft: val("rpa-height-ft"),
						in: val("rpa-height-in"),
					};
		const weight =
			units === "metric"
				? { units: "kg", value: val("rpa-weight-kg") }
				: { units: "lb", value: val("rpa-weight-lb") };

		return {
			units: units,
			height: height,
			weight: weight,
			age: val("rpa-age"),
			gender: val("rpa-gender"),
			experience: activeExp ? activeExp.dataset.value : "",
			monthlyVolume: { value: val("rpa-volume"), unit: "km" },
			pace: {
				value:
					val("rpa-pace-min") +
					":" +
					String(val("rpa-pace-sec")).padStart(2, "0"),
				unit: "km",
			},
			goal: val("rpa-goal"),
			raceDistance: val("rpa-race-distance"),
			raceDate: val("rpa-race-date"),
		};
	}

	// ----- Event wiring -----

	fileInput.addEventListener("change", function (event) {
		addFiles(event.target.files);
		// Reset so selecting the same file again still fires a change event.
		fileInput.value = "";
	});

	// Drag-and-drop support on the dropzone label.
	["dragenter", "dragover"].forEach(function (eventName) {
		dropzone.addEventListener(eventName, function (event) {
			event.preventDefault();
			dropzone.classList.add("is-dragover");
		});
	});

	["dragleave", "drop"].forEach(function (eventName) {
		dropzone.addEventListener(eventName, function (event) {
			event.preventDefault();
			dropzone.classList.remove("is-dragover");
		});
	});

	dropzone.addEventListener("drop", function (event) {
		if (event.dataTransfer && event.dataTransfer.files) {
			addFiles(event.dataTransfer.files);
		}
	});

	clearBtn.addEventListener("click", function () {
		selectedFiles = [];
		resultsSection.hidden = true;
		demoBadge.hidden = true;
		resultsNote.textContent = DEFAULT_NOTE;
		refreshUi();
	});

	// Analyse button: locks upload area, shows loading overlay, calls the API, then renders results.
	analyseBtn.addEventListener("click", async function () {
		// Snapshot the runner profile at the moment of submission.
		runnerProfile = getProfile();

		// Capture file references for FormData AND ObjectURLs for the photo strip
		// before clearing selectedFiles so neither is lost.
		var filesToSend = selectedFiles.slice();
		var photoUrls = filesToSend.map(function (file) {
			return URL.createObjectURL(file);
		});

		// Clear the upload preview immediately — the files are held in filesToSend above.
		selectedFiles = [];
		refreshUi();
		dropzone.classList.add("is-locked");

		// Show the template dashboard layout so results section is already visible.
		demoBadge.hidden = true;
		resultsNote.textContent =
			"Analysing your running form — this may take up to 30 seconds…";
		renderResults("template");
		resultsSection.hidden = false;
		resultsSection.scrollIntoView({ behavior: "smooth" });

		// Start the loading overlay with rotating prompts.
		startLoader();

		// Mark the button while the request is in flight.
		var originalLabel = analyseBtn.textContent;
		analyseBtn.disabled = true;
		analyseBtn.textContent = "Analysing…";

		// Build a multipart form from the captured files.
		var formData = new FormData();
		filesToSend.forEach(function (file) {
			formData.append("images", file);
		});
		formData.append("profile", JSON.stringify(runnerProfile));

		try {
			var response = await fetch(
				"/projects/running-posture-analyser/analyse",
				{
					method: "POST",
					body: formData,
				},
			);

			if (!response.ok) {
				var errBody = await response.json().catch(function () {
					return {};
				});
				throw new Error(
					errBody.error ||
						"Analysis failed (HTTP " + response.status + ").",
				);
			}

			var aiData = await response.json();
			resultsNote.textContent =
				"Analysis complete. Observations are based on the photos you uploaded.";
			renderResults("ai", aiData);
			// Show the submitted photos in the results section.
			renderPhotoStrip(photoUrls);
		} catch (err) {
			resultsNote.textContent =
				"Analysis failed: " + err.message + " Please try again.";
			// On error: restore files and unlock the dropzone so the user can retry.
			selectedFiles = filesToSend;
			dropzone.classList.remove("is-locked");
		} finally {
			stopLoader();
			analyseBtn.textContent = originalLabel;
			// Re-evaluate: after success selectedFiles is empty so button stays disabled;
			// after error selectedFiles is restored so button re-enables.
			analyseBtn.disabled = !(
				selectedFiles.length > 0 && isProfileComplete()
			);
		}
	});

	// Demo button reveals the fully populated sample dashboard.
	demoBtn.addEventListener("click", function () {
		demoBadge.hidden = false;
		resultsNote.textContent = DEMO_NOTE;
		renderResults("demo");
		resultsSection.hidden = false;
		resultsSection.scrollIntoView({ behavior: "smooth" });
	});

	// New analysis button: resets the full upload cycle and scrolls back to the profile form.
	newAnalysisBtn.addEventListener("click", function () {
		selectedFiles = [];
		photoStrip.hidden = true;
		photoStrip.innerHTML = "";
		scoreSummary.hidden = true;
		dropzone.classList.remove("is-locked");
		resultsSection.hidden = true;
		demoBadge.hidden = true;
		resultsNote.textContent = DEFAULT_NOTE;
		refreshUi();
		document
			.getElementById("rpa-profile-form")
			.scrollIntoView({ behavior: "smooth" });
	});

	// Re-evaluate the analyse button whenever any profile field changes.
	const profileForm = document.getElementById("rpa-profile-form");
	profileForm.addEventListener("input", refreshUi);
	profileForm.addEventListener("change", refreshUi);

	// Initialise the UI in its empty state.
	refreshUi();
});
