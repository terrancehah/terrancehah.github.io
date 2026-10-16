document.addEventListener('DOMContentLoaded', function() {
    // footer.js runs on every page that loads it — the footer nav and
    // the back-to-top button are universal. Pages with their own
    // footer (e.g. Pacey) simply never include this script.
    const footer = document.createElement('footer');
    footer.className = 'footer site-footer'; // .site-footer scopes the shared footer styles

    // Normalize hrefs so './articles.html', '/articles.html', the
    // clean-URL '/articles' and deep paths all compare consistently.
    const normalizePath = function(href) {
        return new URL(href, location.href).pathname
            .replace(/\/index\.html$/, '/')
            .replace(/\.html$/, '')
            .replace(/\/+$/, '') || '/';
    };
    const here = normalizePath(location.pathname);

    const footerLinks = [
        ['Home', '/'],
        ['Articles', '/articles.html'],
        ['Projects', '/projects.html'],
        ['Playground', '/playground.html'],
    ];
    // aria-current="page" on the exact destination; "location" when the
    // current URL merely sits under that section (e.g. an article page
    // marks the Articles link) — never "page" for detail pages.
    const items = footerLinks.map(function(entry) {
        const label = entry[0];
        const href = entry[1];
        const target = normalizePath(href);
        let current = '';
        if (here === target) {
            current = ' aria-current="page"';
        } else if (target !== '/' && here.startsWith(target + '/')) {
            current = ' aria-current="location"';
        }
        return '<a href="' + href + '"' + current + '>' + label + '</a>';
    }).join('');

    // Constrained inner row: footer nav left, credit lines right on
    // desktop — stacked and left-aligned on narrow screens (CSS).
    footer.innerHTML =
        '<div class="site-footer-inner">' +
            '<nav class="site-footer-nav" aria-label="Footer">' + items + '</nav>' +
            '<div class="site-footer-meta">' +
                '<p class="site-footer-credit">Copyright © ' + new Date().getFullYear() + ', Terrance Hah.</p>' +
                '<p class="site-footer-notice">This site does not store cookies on your computer.</p>' +
            '</div>' +
        '</div>';
    document.body.appendChild(footer);

    // Back-to-top: a small fixed button that only appears after the
    // page is scrolled past one viewport, and never stays focusable
    // while hidden (the [hidden] attribute keeps it out of the tab
    // order entirely).
    const backToTop = document.createElement('button');
    backToTop.type = 'button';
    backToTop.className = 'back-to-top';
    backToTop.setAttribute('aria-label', 'Back to top');
    // Inline Lucide-style arrow-up-to-line icon — no dependency,
    // decorative only (aria-hidden), label lives on the button.
    backToTop.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
            '<path d="M12 19V7"/>' +
            '<path d="m6 13 6-6 6 6"/>' +
            '<path d="M5 4h14"/>' +
        '</svg>';
    backToTop.hidden = true;
    document.body.appendChild(backToTop);

    // Keyboard activation parks focus on the header's first nav link
    // before scrolling so the user can keep tabbing. Some pages have
    // no header nav — both guards stay optional.
    const headerNav = document.querySelector('header nav');
    const headerFirstLink = headerNav ? headerNav.querySelector('a') : null;

    let ticking = false;
    const updateVisibility = function() {
        ticking = false;
        const show = window.scrollY > window.innerHeight;
        if (show === !backToTop.hidden) {
            return; // already in the right state
        }
        // Move focus off the button before hiding it — an element that
        // just became [hidden] must not keep focus.
        if (!show && document.activeElement === backToTop && headerFirstLink) {
            headerFirstLink.focus({ preventScroll: true });
        }
        backToTop.hidden = !show;
    };
    const requestUpdate = function() {
        if (!ticking) {
            ticking = true;
            requestAnimationFrame(updateVisibility);
        }
    };
    window.addEventListener('scroll', requestUpdate, { passive: true });
    // Resizing changes innerHeight — the show threshold — so re-check.
    window.addEventListener('resize', requestUpdate, { passive: true });
    // Evaluate once on load too: a restored scroll position (reload,
    // bfcache) should show the button without waiting for a scroll.
    updateVisibility();

    backToTop.addEventListener('click', function(e) {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        // detail === 0 means keyboard/AT activation rather than a
        // pointer click — move focus first, then scroll.
        if (e.detail === 0 && headerFirstLink) {
            headerFirstLink.focus({ preventScroll: true });
        }
        // 'instant' rather than 'auto': auto would still be smooth on
        // the homepage, whose html rule sets scroll-behavior: smooth.
        window.scrollTo({ top: 0, behavior: reduced ? 'instant' : 'smooth' });
    });
});
