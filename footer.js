document.addEventListener('DOMContentLoaded', function() {
    const footer = document.createElement('footer');
    footer.className = 'footer'; // Add your footer's class name here
    footer.innerHTML = `
    <div class="text-center my-2">
        <h3 class="copyright sm:text-lg md:text-xl lg:text-xl font-lato font-semibold text-primary">Copyright © ${new Date().getFullYear()}, Terrance Hah.<br>
        </h3>
        <h4 class="cookie-notice sm:text-lg md:text-xl lg:text-lg font-raleway font-medium text-primary">This site does not store cookies on your computer.</h4>
    </div>
        
    `;
    document.body.appendChild(footer);
});