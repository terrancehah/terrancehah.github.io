/* =====================================================================
   PACEY LANDING — theme toggle, fixture sync + the sample radar
   ---------------------------------------------------------------------
   The page renders fully without JS. This file wires the theme toggle,
   rewrites the static metric tiles and week agenda from the shared demo
   fixture (so the previews cannot drift), and — when Chart.js is
   available — mounts the shared read-only radar (pacey-radar.js) over
   the printed scores fallback. It follows the app's exact theme rule: a
   saved pacey_theme choice wins, otherwise dark between 7pm and 7am
   local time.
   ===================================================================== */

(function () {
    'use strict';

    /* ---- Theme toggle ---- */
    var toggle = document.getElementById('landing-theme-toggle');
    if (toggle) {
        // Mirror the app's applyTheme — same attribute, same storage key,
        // same accessible label — so landing and app never disagree.
        var applyTheme = function (theme) {
            document.documentElement.setAttribute('data-theme', theme);
            try { localStorage.setItem('pacey_theme', theme); } catch (e) {}
            var label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
            toggle.setAttribute('aria-label', label);
            toggle.title = label;
        };

        toggle.addEventListener('click', function () {
            var current = document.documentElement.getAttribute('data-theme') || 'light';
            applyTheme(current === 'light' ? 'dark' : 'light');
        });

        // Correct the label for whatever theme the head script applied —
        // the static markup can't know whether dark mode is active.
        var active = document.documentElement.getAttribute('data-theme') || 'light';
        var label = active === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
        toggle.setAttribute('aria-label', label);
        toggle.title = label;
    }

    /* ---- App-entry links keep app page hashes ----
       A signed-out bounce lands here carrying the page the session expired
       on (#plan and friends), and an old bookmark may do the same. The
       Open Pacey links take that hash through so a fresh sign-in returns
       to the same page. Landing's own anchors (#features and below) never
       qualify — the whitelist is app pages only. */
    var appHash = /#(overview|activities|readiness|plan)$/.test(window.location.hash)
        ? window.location.hash : '';
    if (appHash) {
        document.querySelectorAll('a[href^="/pacey/app/"]').forEach(function (a) {
            a.setAttribute('href', a.getAttribute('href') + appHash);
        });
    }

    /* ---- Questions accordion ----
       Progressive enhancement only: the markup ships every answer open
       inside a grid-rows panel, so no-JS and crawlers read the full FAQ
       (and it mirrors the FAQPage schema verbatim). Here each dt's text
       is wrapped in a real button with a chevron, wired to its dd, and
       only then is the panel collapsed — an enhancement that fails
       halfway still leaves the answers visible. Independent drawers:
       opening one never closes another. */
    var questionList = document.querySelector('.landing-questions');
    if (questionList) {
        var SVG_NS_Q = 'http://www.w3.org/2000/svg';

        // One shared open/close for the drawers — mirrors the app's
        // disclosure contract: is-open drives the CSS animation, inert
        // and aria-hidden keep a closed panel out of both tab order and
        // the accessibility tree, and a collapse that steals focus hands
        // it back to the toggle.
        var setLandingDisclosureExpanded = function (panel, open, trigger) {
            panel.classList.toggle('is-open', open);
            panel.inert = !open;
            if (open) {
                panel.removeAttribute('aria-hidden');
            } else {
                panel.setAttribute('aria-hidden', 'true');
                if (panel.contains(document.activeElement)) {
                    trigger.focus();
                }
            }
            trigger.setAttribute('aria-expanded', String(open));
        };

        questionList.querySelectorAll('.landing-question-term').forEach(function (dt) {
            var dd = dt.parentElement.querySelector('.landing-question-answer');
            if (!dd || !dd.id) return;

            // The question text becomes the button label; the chevron is
            // decorative and marked hidden.
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'landing-question-toggle';
            btn.setAttribute('aria-controls', dd.id);
            btn.setAttribute('aria-expanded', 'true');
            var q = document.createElement('span');
            q.className = 'landing-question-toggle-text';
            q.textContent = dt.textContent;
            var chev = document.createElementNS(SVG_NS_Q, 'svg');
            chev.setAttribute('class', 'landing-question-chevron');
            chev.setAttribute('viewBox', '0 0 16 16');
            chev.setAttribute('aria-hidden', 'true');
            chev.setAttribute('focusable', 'false');
            var path = document.createElementNS(SVG_NS_Q, 'path');
            path.setAttribute('d', 'M3 6l5 5 5-5');
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', 'currentColor');
            path.setAttribute('stroke-width', '2');
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('stroke-linejoin', 'round');
            chev.appendChild(path);
            btn.appendChild(q);
            btn.appendChild(chev);
            dt.textContent = '';
            dt.appendChild(btn);

            // Attach first, collapse second — a listener must exist before
            // the panel closes or the drawer could end up sealed shut.
            btn.addEventListener('click', function () {
                setLandingDisclosureExpanded(dd, !dd.classList.contains('is-open'), btn);
            });
            setLandingDisclosureExpanded(dd, false, btn);
        });
    }

    /* ---- Evidence rail marker + scroll reveals ----
       One observer marks whichever stream section crosses the
       upper-third band as the rail's "current" link; a second stamps
       .landing-reveal-ready on the big preview blocks as they enter.
       Everything fails open — no IntersectionObserver, reduced motion or
       a thrown setup leaves every block fully visible, and this runs
       before the radar's early returns so a missing Chart.js can never
       disable the effects. */
    (function () {
        var reduceMotion = window.matchMedia
            ? window.matchMedia('(prefers-reduced-motion: reduce)')
            : null;

        // The rail's location marker — a thin band a third of the way
        // down the viewport decides which chapter is current. Whichever
        // stream section covers the band wins; ties go to the topmost
        // one in document order.
        var railLinks = document.querySelectorAll('.landing-evidence-link');
        if (railLinks.length && 'IntersectionObserver' in window) {
            try {
                var streamIds = [];
                railLinks.forEach(function (link) {
                    streamIds.push(link.getAttribute('href').slice(1));
                });
                var inBand = {};
                var railObserver = null;
                var setActive = function (id) {
                    railLinks.forEach(function (link) {
                        if (link.getAttribute('href') === '#' + id) {
                            link.setAttribute('aria-current', 'location');
                        } else {
                            link.removeAttribute('aria-current');
                        }
                    });
                };
                // Deepest intersecting section wins — the standard
                // scrollspy rule: a section claims the marker the moment
                // its top enters the band, even while the previous one
                // still overlaps it (and symmetrically scrolling up).
                var pickCurrent = function () {
                    var hit = null;
                    for (var i = 0; i < streamIds.length; i++) {
                        if (inBand[streamIds[i]]) hit = streamIds[i];
                    }
                    if (hit) setActive(hit);
                };
                // rootMargin percentages resolve against the root's WIDTH,
                // not its height — so the upper-third band is spelled out
                // in pixels from innerHeight and rebuilt on resize.
                var buildRailObserver = function () {
                    if (railObserver) railObserver.disconnect();
                    inBand = {};
                    var h = window.innerHeight || 800;
                    railObserver = new IntersectionObserver(function (entries) {
                        entries.forEach(function (entry) {
                            inBand[entry.target.id] = entry.isIntersecting;
                        });
                        pickCurrent();
                    }, {
                        rootMargin: (-Math.round(h * 0.3)) + 'px 0px ' +
                            (-Math.round(h * 0.6)) + 'px 0px',
                        threshold: 0
                    });
                    streamIds.forEach(function (id) {
                        var section = document.getElementById(id);
                        if (section) railObserver.observe(section);
                    });
                };
                buildRailObserver();
                // A resize changes the band's pixel geometry — rebuild the
                // observer (rAF-debounced) and clear inBand so no stale
                // selection survives the swap.
                var railResizeTick = null;
                window.addEventListener('resize', function () {
                    if (railResizeTick) return;
                    railResizeTick = requestAnimationFrame(function () {
                        railResizeTick = null;
                        buildRailObserver();
                    });
                });
            } catch (railErr) {
                // The marker is decorative — a failed setup just leaves the
                // links plain, and the reveals below still run.
            }
        }

        // Entrance reveals — targets are whole exhibits (the readiness,
        // trends, course, picture, plan and recap figures, so each card
        // arrives together with its phone caption, plus the metrics grid
        // as one unit), never individual paragraphs or tiles. The FAQ list
        // and the closing call to action are the two blocks that used to
        // appear with no entrance at all; the CTA's own heading still stays
        // instant, like every other heading here.
        var revealEls = Array.prototype.slice.call(document.querySelectorAll([
            '#features .landing-feature-exhibit',
            '#metrics .pacey-metrics-grid',
            '#training-trends .landing-feature-exhibit',
            '#course .landing-feature-exhibit',
            '#picture .landing-feature-exhibit',
            '#plan .landing-feature-exhibit',
            '#recap .landing-feature-exhibit',
            '#questions .landing-questions',
            '.landing-final .landing-hero-actions',
            '.landing-final .landing-notes'
        ].join(', ')));
        if (!revealEls.length) return;
        var revealAll = function () {
            revealEls.forEach(function (el) {
                el.classList.add('landing-reveal', 'landing-reveal-ready');
            });
        };

        // No observer or motion-averse preference: never hide anything. The
        // heading underlines are withheld by a clip on a pseudo-element rather
        // than by a class, so they have to be drawn in here as well — leaving
        // this branch without doing so would strip the stroke from every
        // section heading on the page.
        if (!('IntersectionObserver' in window) || (reduceMotion && reduceMotion.matches)) {
            document.querySelectorAll('.landing-section-title').forEach(function (title) {
                title.classList.add('landing-title-drawn');
            });
            return;
        }

        try {
            var revealObserver = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('landing-reveal-ready');
                        revealObserver.unobserve(entry.target);
                    }
                });
                // A deep anchor can jump after this script ran: anything
                // the browser has already scrolled past is revealed
                // outright — it stays offscreen anyway, so no flash.
                revealEls.forEach(function (el) {
                    if (!el.classList.contains('landing-reveal-ready') &&
                        el.getBoundingClientRect().bottom <= 0) {
                        el.classList.add('landing-reveal-ready');
                        revealObserver.unobserve(el);
                    }
                });
            }, { threshold: 0.1, rootMargin: '0px 0px -32px 0px' });
            revealEls.forEach(function (el) {
                el.classList.add('landing-reveal');
                // Blocks already scrolled past (deep anchors, restored
                // scroll positions) get the ready class in the same style
                // flush — no fade, nothing hidden above the fold.
                if (el.getBoundingClientRect().bottom <= 0) {
                    el.classList.add('landing-reveal-ready');
                } else {
                    revealObserver.observe(el);
                }
            });

            // Plan rows ride their week block's reveal with a small
            // capped stagger — DOM order, 45ms a row, 180ms at most.
            var weekBlock = document.querySelector('#plan .pacey-cal-week-block');
            if (weekBlock) {
                weekBlock.querySelectorAll('.pacey-cal-row').forEach(function (row, i) {
                    row.style.setProperty('--landing-stagger', Math.min(i * 45, 180) + 'ms');
                });
            }

            // The FAQ list gets the same treatment — a slightly tighter
            // stagger, since its rows are shorter than calendar days.
            var faqList = document.querySelector('#questions .landing-questions');
            if (faqList) {
                faqList.querySelectorAll('.landing-question').forEach(function (item, i) {
                    item.style.setProperty('--landing-stagger', Math.min(i * 40, 160) + 'ms');
                });
            }

            // The hand-sketched underline under each section heading draws
            // itself as the section arrives. Separate from the reveal above,
            // because the heading itself must never fade — only its stroke
            // is withheld. Headings already on screen at load draw straight
            // away, which reads as part of the page settling rather than as
            // something triggered by a scroll that never happened.
            var drawnTitles = Array.prototype.slice.call(
                document.querySelectorAll('.landing-section-title')
            );

            // One stroke per heading, so a run of them never looks stamped.
            // Three things vary: which of the six shapes is used, how long the
            // stroke runs against its text, and how far it tilts. The pairings
            // are a fixed list rather than a fresh roll per visit — the aim is
            // that no two headings match, not that the page changes under the
            // runner every time they reload it.
            var STROKE_VARIATION = [
                { shape: 3, scale: 1.08, tilt: -1.1 },
                { shape: 5, scale: 0.93, tilt: 0.9 },
                { shape: 1, scale: 1.05, tilt: -0.6 },
                { shape: 6, scale: 0.91, tilt: 1.4 },
                { shape: 2, scale: 1.09, tilt: -0.8 },
                { shape: 4, scale: 0.95, tilt: 1.0 },
                { shape: 5, scale: 1.06, tilt: 0.5 },
                { shape: 3, scale: 0.94, tilt: -1.3 },
                { shape: 6, scale: 1.02, tilt: 0.8 },
                { shape: 2, scale: 0.97, tilt: -0.9 }
            ];
            drawnTitles.forEach(function (title, i) {
                var v = STROKE_VARIATION[i % STROKE_VARIATION.length];
                title.style.setProperty('--landing-stroke', 'var(--landing-stroke-' + v.shape + ')');
                title.style.setProperty('--landing-stroke-scale', v.scale);
                title.style.setProperty('--landing-stroke-tilt', v.tilt + 'deg');
            });

            if (drawnTitles.length) {
                var drawObserver = new IntersectionObserver(function (entries) {
                    entries.forEach(function (entry) {
                        if (entry.isIntersecting) {
                            entry.target.classList.add('landing-title-drawn');
                            drawObserver.unobserve(entry.target);
                        }
                    });
                }, { threshold: 0, rootMargin: '0px 0px -48px 0px' });
                drawnTitles.forEach(function (title) {
                    title.classList.add('landing-title-draw');
                    var box = title.getBoundingClientRect();
                    if (box.top < window.innerHeight && box.bottom > 0) {
                        // Already on screen at load: let the stroke draw as the
                        // page settles. Two frames, because a class added in
                        // the same flush as the state it changes produces no
                        // transition at all — the browser never paints the
                        // withheld version it would animate away from.
                        requestAnimationFrame(function () {
                            requestAnimationFrame(function () {
                                title.classList.add('landing-title-drawn');
                            });
                        });
                    } else {
                        drawObserver.observe(title);
                    }
                });
            }

            // A mid-visit flip to reduced motion drops the animation and
            // shows everything that was still waiting.
            if (reduceMotion && reduceMotion.addEventListener) {
                reduceMotion.addEventListener('change', function (e) {
                    if (e.matches) {
                        revealObserver.disconnect();
                        revealAll();
                        // The underline is not a reveal, so it needs its own
                        // undo — every heading draws in at once instead.
                        drawnTitles.forEach(function (title) {
                            title.classList.add('landing-title-drawn');
                        });
                    }
                });
            }
        } catch (err) {
            // Fail open: undo any hidden state the setup managed to stamp.
            revealAll();
        }
    })();

    /* ---- Metric tiles ----
       Same drift guard as the week: the static markup already carries the
       right numbers, and this pass rewrites them from the shared fixture
       so the preview can never disagree with the demo — value, unit, the
       zone-colour token and the icon the app maps the label to. */
    if (window.PACEY_SAMPLE && Array.isArray(PACEY_SAMPLE.metrics)) {
        PACEY_SAMPLE.metrics.forEach(function (m) {
            var tile = document.querySelector('.pacey-metric-tile[data-metric-label="' + m.label + '"]');
            if (!tile) return;
            var label = tile.querySelector('.pacey-metric-label');
            var value = tile.querySelector('.pacey-metric-value');
            var unit = tile.querySelector('.pacey-metric-unit');
            var icon = tile.querySelector('.pacey-metric-icon .pacey-icon');
            var use = icon && icon.querySelector('use');
            if (label) label.textContent = m.label;
            if (value) {
                value.textContent = m.value;
                value.style.color = 'var(--pacey-metric-zone-' + (m.colorToken || 'blue') + ')';
            }
            if (unit) unit.textContent = m.unit;
            if (use && m.icon) use.setAttribute('href', '#' + m.icon);
            if (icon) icon.classList.toggle('pacey-icon--stroke', !!m.stroke);
        });
    }

    /* ---- Sample week ----
       The agenda markup is static so the page reads without JS, but the
       values are the shared fixture's: pacey-sample.js stays the single
       source and this pass rewrites text (never the markup's structure)
       so the rows cannot drift from what the demo plan would show. Runs
       before the radar mount so a missing Chart.js can't skip it. */
    if (window.PACEY_SAMPLE && Array.isArray(PACEY_SAMPLE.week)) {
        PACEY_SAMPLE.week.forEach(function (day, i) {
            var row = document.querySelector('.pacey-cal-row[data-sample-day="' + i + '"]');
            if (!row) return;
            var card = row.querySelector('.pacey-cal-card');
            var title = row.querySelector('.pacey-cal-card-title');
            var meta = row.querySelector('.pacey-cal-card-meta');
            var tag = row.querySelector('.pacey-run-tag');
            var dow = row.querySelector('.pacey-cal-date-dow');
            var restLabel = row.querySelector('.pacey-cal-rest-label');
            if (dow && day.day) dow.textContent = day.day;
            if (!card) return;
            if (day.rest) {
                card.className = 'pacey-cal-card pacey-cal-card--rest';
                if (restLabel) restLabel.textContent = day.title || 'Rest';
            } else {
                card.className = 'pacey-cal-card pacey-cal-card--suggested';
                if (title) title.textContent = day.title;
                if (meta) meta.textContent = day.distance_km + ' km · ' + day.pace + '/km';
                if (tag) {
                    tag.textContent = day.type;
                    tag.className = 'pacey-run-tag ' + day.tagClass;
                }
            }
        });
    }

    /* ---- Course preview ----
       The Brooks snapshot is a static local asset — the same numbers the
       app's course analysis produced for the supplied GPX. One fetch
       draws the chalk route trace and the elevation profile; if it never
       resolves, the card keeps its name, stats and read — no skeleton. */
    (function () {
        var routeLine = document.getElementById('landing-course-route-line');
        var routeSvg = document.getElementById('landing-course-route-svg');
        var mapEl = document.getElementById('landing-course-map');
        var chartWrap = document.getElementById('landing-course-chart-wrap');
        var pending = document.getElementById('landing-course-pending');
        if (!routeLine || !chartWrap || !window.fetch) return;

        var SVG_NS = 'http://www.w3.org/2000/svg';

        /* A plain circle path run through the board's sketch filter — the
           same wobble the app's sketched dots get from their path math. */
        function circlePath(cx, cy, r) {
            return 'M' + (cx - r) + ' ' + cy +
                ' a' + r + ' ' + r + ' 0 1 0 ' + (r * 2) + ' 0' +
                ' a' + r + ' ' + r + ' 0 1 0 -' + (r * 2) + ' 0 Z';
        }

        function drawRoute(rec) {
            var route = rec.route;
            if (!route || !route.d) return;
            if (routeSvg && route.viewBox) routeSvg.setAttribute('viewBox', route.viewBox);
            routeLine.setAttribute('d', route.d);
            var startPin = document.getElementById('landing-course-route-start');
            var endPin = document.getElementById('landing-course-route-end');
            if (!startPin || !route.start) return;
            /* Brooks finishes where it starts — one split start/finish
               dot, the same treatment the app gives a loop. */
            startPin.setAttribute('d', circlePath(route.start.x, route.start.y, 12));
            startPin.style.fill = 'url(#pacey-course-split)';
            if (endPin) endPin.hidden = true;
        }

        function drawElevation(rec) {
            var pts = rec.profile;
            if (!pts || !pts.length) return;
            var w = Math.max(chartWrap.clientWidth, 260);
            var h = Math.max(chartWrap.clientHeight, 120);
            var pad = { top: 10, right: 8, bottom: 18, left: 8 };
            var minEle = Math.min.apply(null, pts.map(function (p) { return p.ele; }));
            var maxEle = Math.max.apply(null, pts.map(function (p) { return p.ele; }));
            var spanEle = Math.max(maxEle - minEle, 1);
            var maxKm = rec.distanceKm;
            var x = function (km) { return pad.left + (km / maxKm) * (w - pad.left - pad.right); };
            var y = function (ele) { return pad.top + (1 - (ele - minEle) / spanEle) * (h - pad.top - pad.bottom); };

            var svg = document.createElementNS(SVG_NS, 'svg');
            svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
            svg.setAttribute('preserveAspectRatio', 'none');
            svg.setAttribute('role', 'img');
            svg.setAttribute('aria-label', 'Elevation profile across the course — 0 to ' + maxKm.toFixed(1) + ' km');
            svg.setAttribute('class', 'landing-course-chart');

            /* Faint chalk gridlines at low, mid and high elevation. */
            [minEle, (minEle + maxEle) / 2, maxEle].forEach(function (ele) {
                var g = document.createElementNS(SVG_NS, 'line');
                g.setAttribute('x1', pad.left);
                g.setAttribute('x2', w - pad.right);
                g.setAttribute('y1', y(ele));
                g.setAttribute('y2', y(ele));
                g.setAttribute('class', 'landing-course-chart-grid');
                svg.appendChild(g);
            });

            /* Filled area under the line, then the chalk line itself. */
            var line = 'M' + pts.map(function (p) {
                return x(p.km).toFixed(1) + ' ' + y(p.ele).toFixed(1);
            }).join(' L');
            var area = document.createElementNS(SVG_NS, 'path');
            area.setAttribute('d', line + ' L' + x(maxKm).toFixed(1) + ' ' + (h - pad.bottom) + ' L' + x(0).toFixed(1) + ' ' + (h - pad.bottom) + ' Z');
            area.setAttribute('class', 'landing-course-chart-area');
            svg.appendChild(area);
            var trace = document.createElementNS(SVG_NS, 'path');
            trace.setAttribute('d', line);
            trace.setAttribute('class', 'landing-course-chart-line');
            svg.appendChild(trace);

            /* Distance markers along the bottom edge. */
            [[0, '0'], [maxKm / 2, (maxKm / 2).toFixed(1)], [maxKm, maxKm.toFixed(1)]].forEach(function (mark) {
                var t = document.createElementNS(SVG_NS, 'text');
                t.setAttribute('x', Math.min(Math.max(x(mark[0]), pad.left + 4), w - pad.right - 26));
                t.setAttribute('y', h - 5);
                t.setAttribute('class', 'landing-course-chart-tick');
                t.textContent = mark[1] + ' km';
                svg.appendChild(t);
            });

            chartWrap.appendChild(svg);
        }

        /* ---- Basemap ----
           Mirrors the app's inline card map (pacey.js buildCourseMap +
           applyCourseRouteLayers) at landing scale: the same OpenFreeMap
           Positron style, bounds fit and compact attribution, and the same
           route line and start/finish pen marks. Non-interactive — it is a
           picture of the course, and an interactive map inside a scrolling
           page would trap the page's own gestures. The modal-only guides
           (direction arrows, kilometre dots) are deliberately left off.

           The drawn SVG stays visible until the map has loaded AND the
           route layer is on it, so the panel is never an empty box while
           tiles stream in — and stays forever if MapLibre, WebGL or the
           tiles are unavailable. */

        /* The three harmonics the app's sketched circles use — copied so
           the landing's pen marks are drawn by the same hand. */
        var SKETCH_LEAN = 0.08;    /* off-centre lean, 1 cycle */
        var SKETCH_OVAL = 0.055;   /* slightly oval, 2 cycles */
        var SKETCH_WRIST = 0.03;   /* wrist lean, 3 cycles */

        /* A hand-drawn-looking circle as an SVG path — same construction
           as the app's sketchyCirclePath: fixed harmonics for the wobble,
           quadratic segments through edge midpoints so it curves. */
        function sketchyCirclePath(cx, cy, r) {
            var n = 16;
            var pts = [];
            for (var i = 0; i < n; i++) {
                var a = (i / n) * Math.PI * 2 - Math.PI / 2;
                var k = 1
                    + SKETCH_LEAN * Math.cos(a - 0.6)
                    + SKETCH_OVAL * Math.cos(2 * a + 1.1)
                    + SKETCH_WRIST * Math.cos(3 * a + 2.4);
                pts.push([cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k]);
            }
            var d = 'M' + pts[0][0].toFixed(2) + ' ' + pts[0][1].toFixed(2);
            for (var j = 1; j <= n; j++) {
                var cur = pts[j % n];
                var next = pts[(j + 1) % n];
                var mx = (cur[0] + next[0]) / 2;
                var my = (cur[1] + next[1]) / 2;
                d += ' Q' + cur[0].toFixed(2) + ' ' + cur[1].toFixed(2) +
                    ' ' + mx.toFixed(2) + ' ' + my.toFixed(2);
            }
            return d + ' Z';
        }

        /* The coach's rougher pen ring — same harmonics pushed harder, and
           the sweep laps past its own start like a hand-drawn circle. */
        function sketchyRingPath(cx, cy, r) {
            var n = 18;
            var turns = 1.14;
            var pts = [];
            for (var i = 0; i <= n; i++) {
                var a = (i / n) * Math.PI * 2 * turns - Math.PI / 2;
                var k = 1
                    + (SKETCH_LEAN * 1.5) * Math.cos(a - 0.5)
                    + (SKETCH_OVAL * 1.4) * Math.cos(2 * a + 1.3)
                    + (SKETCH_WRIST * 1.4) * Math.cos(3 * a + 2.2);
                var squash = 0.93 + 0.04 * Math.cos(a + 0.8);
                pts.push([cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k * squash]);
            }
            var d = 'M' + pts[0][0].toFixed(2) + ' ' + pts[0][1].toFixed(2);
            for (var j = 1; j < pts.length - 1; j++) {
                var cur = pts[j];
                var next = pts[j + 1];
                var mx = (cur[0] + next[0]) / 2;
                var my = (cur[1] + next[1]) / 2;
                d += ' Q' + cur[0].toFixed(2) + ' ' + cur[1].toFixed(2) +
                    ' ' + mx.toFixed(2) + ' ' + my.toFixed(2);
            }
            var last = pts[pts.length - 1];
            return d + ' L' + last[0].toFixed(2) + ' ' + last[1].toFixed(2);
        }

        /* Metres between two [lon,lat] points — enough to answer the same
           "does this route close on itself" question the app's 400 m
           heuristic asks, without loading the course module. */
        function metresBetween(a, b) {
            var rad = Math.PI / 180;
            var dLat = (b[1] - a[1]) * rad;
            var dLon = (b[0] - a[0]) * rad;
            var h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(a[1] * rad) * Math.cos(b[1] * rad)
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
            return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
        }

        /* The app's ROUTE_CLOSES_M threshold: under 400 m of GPS drift the
           start and finish count as the same place. */
        function routeCloses(coords) {
            return metresBetween(coords[0], coords[coords.length - 1]) < 400;
        }

        function markerSvg(wrapClass, px, viewBox) {
            var wrap = document.createElement('div');
            wrap.className = wrapClass;
            var svg = document.createElementNS(SVG_NS, 'svg');
            svg.setAttribute('viewBox', viewBox);
            svg.setAttribute('width', String(px));
            svg.setAttribute('height', String(px));
            svg.setAttribute('aria-hidden', 'true');
            var path = document.createElementNS(SVG_NS, 'path');
            svg.appendChild(path);
            wrap.appendChild(svg);
            return { wrap: wrap, path: path, svg: svg };
        }

        /* A loop's single start/finish dot, split green/red down the middle
           — the same gradient trick the app uses so the sketched outline
           stays one stroke. */
        function makeSplitMarkerElement(size) {
            var m = markerSvg('pacey-course-marker pacey-course-marker--split', size, '0 0 24 24');
            var defs = document.createElementNS(SVG_NS, 'defs');
            var grad = document.createElementNS(SVG_NS, 'linearGradient');
            grad.setAttribute('id', 'pacey-course-split-landing');
            grad.setAttribute('x1', '0');
            grad.setAttribute('y1', '0');
            grad.setAttribute('x2', '1');
            grad.setAttribute('y2', '0');
            [['0', '#2f8f4e'], ['0.5', '#2f8f4e'], ['0.5', '#b83b2e'], ['1', '#b83b2e']]
                .forEach(function (stop) {
                    var s = document.createElementNS(SVG_NS, 'stop');
                    s.setAttribute('offset', stop[0]);
                    s.setAttribute('stop-color', stop[1]);
                    grad.appendChild(s);
                });
            defs.appendChild(grad);
            m.svg.insertBefore(defs, m.path);
            m.path.setAttribute('d', sketchyCirclePath(12, 12, 7.6));
            m.path.setAttribute('fill', 'url(#pacey-course-split-landing)');
            return m.wrap;
        }

        function makeEndpointMarkerElement(kind, size) {
            var m = markerSvg('pacey-course-marker pacey-course-marker--' + kind, size, '0 0 24 24');
            m.path.setAttribute('d', sketchyCirclePath(12, 12, 7.6));
            return m.wrap;
        }

        function makeRingElement(size) {
            var m = markerSvg('pacey-course-ring', size, '0 0 56 56');
            /* The wobble needs room — the ring sits well inside the viewBox
               so its stroke never clips at the edge. */
            m.path.setAttribute('d', sketchyRingPath(28, 28, 19));
            return m.wrap;
        }

        /* Fold MapLibre's compact attribution back to the ⓘ button — the
           style JSON opens it expanded on a wide container, and the full
           credit line would sit on the preview permanently. */
        function collapseAttribution(map) {
            var attrib = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
            if (!attrib) return;
            attrib.removeAttribute('open');
            attrib.classList.remove('maplibregl-compact-show');
        }

        /* The coloured-pencil surface shading the app lays over Positron —
           same palette, same per-layer paint matching, same no-op on any
           layer a style revision renames. */
        function shadeMapLikePencil(map) {
            var SURFACES = {
                paper: ['#f3eee3', '#e7dfcd'],
                water: ['#cfe3f1', '#a9c8dd'],
                park: ['#e6e8d4', '#c6cba9'],
                landcover: ['#e9e1cf', '#cec2a2'],
                landuse: ['#eee6d5', '#d6cbb0'],
                building: ['#e5dcc6', '#cbbfa3'],
            };
            Object.keys(SURFACES).forEach(function (key) {
                var base = SURFACES[key][0];
                var stroke = SURFACES[key][1];
                var size = 32;
                var step = 8;
                var tile = document.createElement('canvas');
                tile.width = size;
                tile.height = size;
                var ctx = tile.getContext('2d');
                ctx.fillStyle = base;
                ctx.fillRect(0, 0, size, size);
                ctx.strokeStyle = stroke;
                ctx.lineWidth = 1.2;
                ctx.lineCap = 'round';
                for (var i = -size; i < size * 2; i += step) {
                    ctx.beginPath();
                    ctx.globalAlpha = 0.45 + ((i / step) % 3) * 0.15;
                    ctx.moveTo(i, 0);
                    ctx.lineTo(i + size, size);
                    ctx.stroke();
                }
                ctx.globalAlpha = 1;
                map.addImage('pacey-hachure-' + key, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
            });
            map.getStyle().layers.forEach(function (layer) {
                try {
                    var src = layer['source-layer'];
                    var paint = layer.paint || {};
                    if (layer.type === 'background' && 'background-color' in paint) {
                        map.setPaintProperty(layer.id, 'background-color', SURFACES.paper[0]);
                        map.setPaintProperty(layer.id, 'background-pattern', 'pacey-hachure-paper');
                    } else if ('fill-color' in paint && SURFACES[src]) {
                        map.setPaintProperty(layer.id, 'fill-color', SURFACES[src][0]);
                        map.setPaintProperty(layer.id, 'fill-pattern', 'pacey-hachure-' + src);
                    } else if ('line-color' in paint && src === 'transportation') {
                        map.setPaintProperty(layer.id, 'line-color', '#d8c9a8');
                    }
                } catch (e) {
                    /* Style revision without this property — leave it. */
                }
            });
        }

        function mountCourseMap(rec) {
            if (!mapEl || !window.maplibregl) return;
            var coords = rec.coords;
            /* Same range check as the app — MapLibre throws on an
               out-of-range latitude, and a malformed record should fall
               back to the drawn trace rather than break the card. */
            var valid = Array.isArray(coords) && coords.length > 1 && coords.every(function (c) {
                return Array.isArray(c) && isFinite(c[0]) && isFinite(c[1])
                    && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90;
            });
            if (!valid) return;

            var bounds = coords.reduce(function (b, c) { return b.extend(c); },
                new maplibregl.LngLatBounds(coords[0], coords[0]));

            /* MapLibre never loads while its container is display:none — the
               map is unhidden now so it gets a real box (it's absolute inside
               the wrap, so the layout doesn't change), while the drawn trace
               stays painted on top until the map's load event trades places.
               The wrap's [hidden] rule already removes it without JS, so the
               no-JS page keeps just the SVG. */
            mapEl.hidden = false;

            var map;
            try {
                map = new maplibregl.Map({
                    container: mapEl,
                    style: 'https://tiles.openfreemap.org/styles/positron',
                    bounds: bounds,
                    fitBoundsOptions: { padding: 26 },
                    /* OpenFreeMap's style JSON ships no attribution of its
                       own — OSM data is ODbL, so the credit is set here.
                       Compact keeps it as the ⓘ button on this small box. */
                    attributionControl: {
                        compact: true,
                        customAttribution: '© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors',
                    },
                    interactive: false,
                });
            } catch (err) {
                /* WebGL refused — put the empty box back away; the drawn
                   trace stays. */
                mapEl.hidden = true;
                return;
            }

            /* The container had a real box at construction, so the bounds
               fit lands right — refit is only the safety net for a box that
               somehow measured 0. One re-fit only, and never on an empty
               box (fitting a 0-size map would latch a nonsense camera). */
            var fitted = !!mapEl.clientWidth;
            function refit() {
                if (!mapEl.clientWidth || !mapEl.clientHeight) return;
                map.resize();
                if (!fitted) {
                    map.fitBounds(bounds, { padding: 26 });
                    fitted = true;
                }
            }
            if (typeof ResizeObserver !== 'undefined') {
                new ResizeObserver(function () {
                    requestAnimationFrame(refit);
                }).observe(mapEl);
            }

            /* A style or tile-network failure before the map is revealed
               leaves the drawn trace in place — re-hide the empty box.
               Once the map is showing (SVG hidden) a stray tile error no
               longer sends it back. */
            map.on('error', function () {
                if (routeSvg.hasAttribute('hidden')) return;
                mapEl.hidden = true;
                try { map.remove(); } catch (e) {}
            });

            map.on('resize', function () { collapseAttribution(map); });
            map.on('load', function () {
                var mapStyle = getComputedStyle(mapEl);
                var routeColor = (mapStyle.getPropertyValue('--pacey-course-map-route') || '').trim() || '#2f6fb0';
                map.addSource('pacey-course-route', {
                    type: 'geojson',
                    data: {
                        type: 'Feature',
                        properties: {},
                        geometry: { type: 'LineString', coordinates: coords },
                    },
                });
                map.addLayer({
                    id: 'pacey-course-route',
                    type: 'line',
                    source: 'pacey-course-route',
                    layout: { 'line-cap': 'round', 'line-join': 'round' },
                    paint: { 'line-color': routeColor, 'line-width': 3 },
                });

                shadeMapLikePencil(map);

                /* Start/finish pen marks — the app's inline treatment: one
                   split dot when the course closes on itself, a sketched
                   ring circling the point. */
                var closes = routeCloses(coords);
                if (closes) {
                    new maplibregl.Marker({ element: makeSplitMarkerElement(18) })
                        .setLngLat(coords[0])
                        .addTo(map);
                } else {
                    new maplibregl.Marker({ element: makeEndpointMarkerElement('start', 18) })
                        .setLngLat(coords[0])
                        .addTo(map);
                    new maplibregl.Marker({ element: makeEndpointMarkerElement('end', 18) })
                        .setLngLat(coords[coords.length - 1])
                        .addTo(map);
                }
                new maplibregl.Marker({ element: makeRingElement(44) })
                    .setLngLat(coords[0])
                    .addTo(map);
                if (!closes) {
                    new maplibregl.Marker({ element: makeRingElement(44) })
                        .setLngLat(coords[coords.length - 1])
                        .addTo(map);
                }

                collapseAttribution(map);
                /* Route is on the map — trade places with the drawn trace
                   and re-measure in case the box shifted while loading.
                   SVG elements have no .hidden IDL property, so the
                   attribute (and the card's [hidden] rule) does the work. */
                routeSvg.setAttribute('hidden', '');
                refit();
            });
        }

        fetch('/pacey/assets/brooks-half-marathon-preview.json')
            .then(function (res) { return res.ok ? res.json() : Promise.reject(res.status); })
            .then(function (rec) {
                drawRoute(rec);
                drawElevation(rec);
                mountCourseMap(rec);
                if (pending) pending.hidden = true;
            })
            .catch(function () {
                /* Quiet static fallback — the card's facts stand without
                   the drawings, and nothing keeps spinning. */
                if (pending) pending.textContent = 'The route and profile could not be drawn here.';
            });
    })();

    /* ---- Training trends ----
       The app's two chart cards rendered from the frozen sample fixture
       — never live data, never recomputed, so the preview cannot drift
       from what the markup prints. Charts mount lazily the first time
       the section scrolls into view (the grow-in plays on screen, not
       while the page loads), stay fully inert — no events, no tooltips —
       and each printed fallback keeps its place until its own chart
       exists. Runs ahead of the radar block so a missing Chart.js cannot
       take either down with it. */
    (function () {
        var trends = window.PACEY_SAMPLE && PACEY_SAMPLE.trainingTrends;
        var mileageCanvas = document.getElementById('landing-mileage-chart');
        var paceCanvas = document.getElementById('landing-pace-chart');
        if (!trends || !mileageCanvas || !paceCanvas) return;

        // The query object is kept (not a one-shot boolean): the charts
        // mount lazily, so the preference is read at creation time, and a
        // mid-animation flip lands both charts instantly via the change
        // listener below.
        var reduceMotion = window.matchMedia
            ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
        var trendCharts = [];

        // Same lookup the app's pinboardChartFonts does — the handwriting
        // stacks and the paper ink arrive through CSS vars on the canvas.
        var canvasVar = function (el, varName, fallbackValue) {
            var value = getComputedStyle(el).getPropertyValue(varName).trim();
            return value || fallbackValue;
        };

        var buildCharts = function () {
            if (!window.Chart) return;
            var headingFont = canvasVar(mileageCanvas, '--pacey-chart-heading-font',
                "'Fuzzy Bubbles', 'Caveat', cursive");
            var muted = canvasVar(mileageCanvas, '--pacey-muted', '#5f5546');
            var grid = canvasVar(mileageCanvas, '--pacey-border', '#dce8f2');
            var animation = (reduceMotion && reduceMotion.matches)
                ? { duration: 0 }
                : { duration: 700, easing: 'easeOutQuart' };

            try {
                trendCharts.push(new Chart(mileageCanvas, {
                    type: 'bar',
                    data: {
                        labels: trends.mileage.labels,
                        datasets: [{
                            // Display-rounded, same as the app's mileage chart
                            data: trends.mileage.kilometers.map(function (km) {
                                return Math.round(km);
                            }),
                            backgroundColor: 'rgba(69, 123, 157, 0.65)',
                            borderColor: 'rgba(69, 123, 157, 1)',
                            borderWidth: 1,
                            borderRadius: 4,
                        }],
                    },
                    options: {
                        // Fully inert preview — hover and touch do nothing.
                        events: [],
                        responsive: true,
                        maintainAspectRatio: false,
                        animation: animation,
                        plugins: {
                            legend: { display: false },
                            tooltip: { enabled: false },
                        },
                        scales: {
                            x: {
                                ticks: { font: { family: headingFont, size: 10 }, color: muted },
                                grid: { display: false },
                            },
                            y: {
                                beginAtZero: true,
                                title: {
                                    display: true,
                                    text: 'km',
                                    font: { family: headingFont, size: 11 },
                                    color: muted,
                                },
                                ticks: {
                                    font: { family: headingFont, size: 10 },
                                    color: muted,
                                    callback: function (v) { return Math.round(v); },
                                },
                                grid: { color: grid },
                            },
                        },
                    },
                }));
                document.getElementById('landing-mileage-fallback').hidden = true;
            } catch (err) {
                // The printed figures stay the whole truth.
            }

            try {
                // The app's pace-bucket palette: hot to cold, goal pace
                // (the middle bucket) always green.
                var paceColors = [
                    'rgba(196, 75, 75, 0.8)',
                    'rgba(204, 182, 42, 0.8)',
                    'rgba(63, 123, 79, 0.8)',
                    'rgba(38, 139, 139, 0.8)',
                    'rgba(69, 123, 157, 0.8)',
                ];
                trendCharts.push(new Chart(paceCanvas, {
                    type: 'bar',
                    data: {
                        // Multi-line labels — each array entry prints as
                        // its own tick line, so they wrap on narrow cards.
                        labels: trends.pace.labels,
                        datasets: [{
                            data: trends.pace.kilometers,
                            backgroundColor: paceColors,
                            borderColor: paceColors.map(function (c) {
                                return c.replace('0.8', '1');
                            }),
                            borderWidth: 1,
                            borderRadius: 4,
                        }],
                    },
                    options: {
                        events: [],
                        responsive: true,
                        maintainAspectRatio: false,
                        animation: animation,
                        plugins: {
                            legend: { display: false },
                            tooltip: { enabled: false },
                        },
                        scales: {
                            x: {
                                title: {
                                    display: true,
                                    text: 'Pace (min/km)',
                                    font: { family: headingFont, size: 11 },
                                    color: muted,
                                },
                                ticks: { font: { family: headingFont, size: 10 }, color: muted },
                                grid: { display: false },
                            },
                            y: {
                                beginAtZero: true,
                                title: {
                                    display: true,
                                    text: 'km',
                                    font: { family: headingFont, size: 11 },
                                    color: muted,
                                },
                                ticks: {
                                    font: { family: headingFont, size: 10 },
                                    color: muted,
                                    callback: function (v) { return Math.round(v); },
                                },
                                grid: { color: grid },
                            },
                        },
                    },
                }));
                document.getElementById('landing-pace-fallback').hidden = true;
            } catch (err) {
                // The printed figures stay the whole truth.
            }
        };

        // A mid-animation flip to reduced motion stops the grow-in where
        // it stands and renders the final bars in the same frame.
        if (reduceMotion && reduceMotion.addEventListener) {
            reduceMotion.addEventListener('change', function (e) {
                if (!e.matches) return;
                trendCharts.forEach(function (c) {
                    c.stop();
                    c.update('none');
                });
            });
        }

        /* First time the section crosses the viewport — never while it
           sits below the fold animating unseen. No observer (or a failed
           one) draws immediately instead. */
        var section = document.getElementById('training-trends');
        if ('IntersectionObserver' in window && section) {
            try {
                var trendsObserver = new IntersectionObserver(function (entries) {
                    entries.forEach(function (entry) {
                        if (entry.isIntersecting) {
                            trendsObserver.disconnect();
                            buildCharts();
                        }
                    });
                }, { threshold: 0.15 });
                trendsObserver.observe(section);
            } catch (err) {
                buildCharts();
            }
        } else {
            buildCharts();
        }
    })();

    /* ---- Sample radar ----
       The same chart the readiness page draws, mounted lazily the first
       time its card scrolls into view. It opens on the app's desaturated
       loading palette with plausible stand-in scores, morphs through a
       fresh random shape every 300ms for two seconds (like the app's
       skeleton shimmer), then settles on Brooks's real scores with the
       standard dataset palette — all on one chart instance, updated in
       place. Reduced motion and a hidden tab skip straight to the real
       scores, and without Chart.js the printed scores inside the wrap
       are the whole truth, so nothing hides. */
    var brooks = window.PACEY_BROOKS_SAMPLE;
    var radarCanvas = document.getElementById('landing-radar');
    var radarFallback = document.getElementById('landing-radar-fallback');
    if (radarCanvas && radarFallback && brooks) (function () {
        var finalValues = brooks.dimensions.map(function (d) { return d.score; });
        var reduceMotion = window.matchMedia
            ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
        var chart = null;
        var timers = [];
        var settled = false;
        // Shuffle budget: a fresh stand-in shape every 300ms for two
        // seconds, then the settle morph lands the real scores — ~2.4s
        // end to end.
        var radarShuffleDurationMs = 2000;
        var radarShuffleStepMs = 300;

        // Same stand-in palette and plausible-score range the app's
        // loading radar uses — never empty, never perfect.
        var randomScores = function () {
            return PaceyRadar.DIMENSIONS.map(function () {
                return 3 + Math.floor(Math.random() * 7);
            });
        };

        var clearTimers = function () {
            timers.forEach(function (t) { clearTimeout(t); });
            timers = [];
        };

        /* Land the real Brooks scores on the live chart — the standard
           dataset palette comes from the shared config, copied property
           by property so the instance is never destroyed. */
        var settle = function () {
            if (!chart || settled) return;
            settled = true;
            clearTimers();
            var finalConfig = PaceyRadar.createConfig({
                canvas: radarCanvas,
                labels: PaceyRadar.DIMENSIONS,
                values: finalValues,
                readOnly: true,
            });
            var ds = chart.data.datasets[0];
            var finalDs = finalConfig.data.datasets[0];
            ds.data = finalDs.data;
            ds.backgroundColor = finalDs.backgroundColor;
            ds.borderColor = finalDs.borderColor;
            ds.pointBackgroundColor = finalDs.pointBackgroundColor;
            // The settle morph only animates while it can be seen and the
            // visitor hasn't asked for stillness — otherwise it lands now.
            var animate = !(reduceMotion && reduceMotion.matches)
                && document.visibilityState !== 'hidden';
            chart.options.animation = animate
                ? { duration: 400, easing: 'easeOutQuart' }
                : { duration: 0 };
            // 'none' applies the final data instantly — no animation
            // frame gets scheduled while the tab is hidden.
            chart.update(animate ? undefined : 'none');
        };

        var shuffleStep = function () {
            if (!chart || settled) return;
            chart.data.datasets[0].data = randomScores();
            chart.options.animation = { duration: 260, easing: 'easeOutQuart' };
            chart.update();
        };

        var begin = function () {
            if (chart || settled) return;
            if (!window.Chart || !window.PaceyRadar) return;
            try {
                chart = PaceyRadar.create(radarCanvas, {
                    labels: PaceyRadar.DIMENSIONS,
                    values: randomScores(),
                    animate: false,
                    // Fully inert — no event listeners, no hover growth.
                    readOnly: true,
                    loading: true,
                    loadingFill: 'rgba(122, 134, 142, 0.07)',
                    loadingLine: 'rgba(122, 134, 142, 0.5)',
                    loadingPoint: 'rgba(122, 134, 142, 0.55)',
                });
            } catch (err) {
                // Creation failed — the printed scores stay visible.
                chart = null;
                return;
            }
            // The chart exists, so the print list trades places. The
            // shuffle stays unblurred — the desaturated palette alone
            // reads as the stand-in.
            radarFallback.hidden = true;
            radarCanvas.classList.add('pacey-radar-loaded');

            // Reduced motion (or a hidden tab at first paint): skip the
            // shuffle entirely and land the real scores at once.
            if ((reduceMotion && reduceMotion.matches)
                    || document.visibilityState === 'hidden') {
                settle();
                return;
            }
            // Seven shapes in the shuffle: the creation draw at ~0ms,
            // then a fresh random set every 300ms until the 2000ms beat
            // settles on the real scores.
            for (var t = radarShuffleStepMs; t < radarShuffleDurationMs; t += radarShuffleStepMs) {
                timers.push(setTimeout(shuffleStep, t));
            }
            timers.push(setTimeout(settle, radarShuffleDurationMs));
        };

        /* Motion should stop the moment it can no longer be wanted or
           seen. If the shuffle is still running, land the real scores now;
           if settle already started a morph, kill that too — the settled
           guard makes settle() a no-op once data is final, so this halts
           an in-flight animation as well as a pending one. */
        var stopMotion = function () {
            if (!chart) return;
            if (!settled) {
                settle();
                return;
            }
            clearTimers();
            chart.stop();
            chart.update('none');
        };
        if (reduceMotion && reduceMotion.addEventListener) {
            reduceMotion.addEventListener('change', function (e) {
                if (e.matches) stopMotion();
            });
        }
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') stopMotion();
        });

        // Mount on first sight — no IntersectionObserver means it draws
        // immediately rather than never.
        if ('IntersectionObserver' in window) {
            try {
                var radarObserver = new IntersectionObserver(function (entries) {
                    entries.forEach(function (entry) {
                        if (entry.isIntersecting) {
                            radarObserver.disconnect();
                            begin();
                        }
                    });
                }, { threshold: 0.15 });
                radarObserver.observe(radarCanvas);
            } catch (err) {
                begin();
            }
        } else {
            begin();
        }
    })();
})();
