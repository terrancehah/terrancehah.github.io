// Make article cards clickable
document.addEventListener('DOMContentLoaded', function() {
    const articleHero = document.querySelector('.article-hero');
    const articleCards = document.querySelectorAll('.article-card');
    
    // Handle hero card click
    if (articleHero) {
        articleHero.addEventListener('click', function(e) {
            // Skip clicks that land on a real link/button (e.g. the title
            // anchor) so the native interaction is preserved.
            if (!e.target.closest('a, button')) {
                const url = this.getAttribute('data-url');
                if (url) {
                    window.location.href = url;
                }
            }
        });
    }
    
    // Handle grid card clicks
    articleCards.forEach(card => {
        card.addEventListener('click', function(e) {
            // Same guard: native anchors inside the card keep working
            // while clicks elsewhere still trigger the card's data-url.
            if (!e.target.closest('a, button')) {
                const url = this.getAttribute('data-url');
                if (url) {
                    window.location.href = url;
                }
            }
        });
    });
});
