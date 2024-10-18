document.addEventListener('DOMContentLoaded', function() {
    const footer = document.createElement('footer');
    footer.className = 'footer'; // Add your footer's class name here
    footer.innerHTML = `
        <h3 class="copyright">Copyright © ${new Date().getFullYear()}, Terrance Hah.<br>
        All rights reserved.</h3>
        <h4 class="cookie-notice">This site does not store cookies on your computer.</h4>
    `;
    document.body.appendChild(footer);
});