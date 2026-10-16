document.addEventListener('DOMContentLoaded', function() {
    const projectHero = document.querySelector('.project-hero');
    const projectCards = document.querySelectorAll('.project-card');
    
    // Handle hero card click
    if (projectHero) {
        projectHero.addEventListener('click', function(e) {
            // Skip clicks that land on a real link/button (e.g. the title
            // anchor) so the native interaction is preserved.
            if (!e.target.closest('a, button')) {
                const url = this.getAttribute('data-url');
                if (url) {
                    if (url.startsWith('http://') || url.startsWith('https://')) {
                        window.open(url, '_blank');
                    } else {
                        window.location.href = url;
                    }
                }
            }
        });
    }
    
    // Handle grid card clicks
    projectCards.forEach(card => {
        card.addEventListener('click', function(e) {
            // Same guard: native anchors inside the card keep working
            // while clicks elsewhere still trigger the card's data-url.
            if (!e.target.closest('a, button')) {
                const url = this.getAttribute('data-url');
                if (url) {
                    if (url.startsWith('http://') || url.startsWith('https://')) {
                        window.open(url, '_blank');
                    } else {
                        window.location.href = url;
                    }
                }
            }
        });
    });
});
