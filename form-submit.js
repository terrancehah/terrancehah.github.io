// Listen to the form submit event
document.getElementById("trip-form").addEventListener("submit", function(e) {
    e.preventDefault();

    // Show loading spinner
    document.getElementById("loadingSpinner").style.display = "flex";

    // Get form values
    var city = document.getElementById("destination").value;
    var startDate = document.getElementById("start-date").value.split(" to ")[0];  // Get only the start date
    var endDate = document.getElementById("hidden-end-date").value;  // Changed from end-date to hidden-end-date
    var language = document.getElementById("language").value;
    var budget = document.getElementById("budget").value;
    var travelPreferences = Array.from(document.querySelectorAll('input[name="travel-preference"]:checked'))
        .map(checkbox => checkbox.value);

    // Validate form data
    if (!city || !startDate || !endDate || !language || !budget) {
        document.getElementById("loadingSpinner").style.display = "none";
        alert('Please fill in all required fields');
        return;
    }

    // Create the base URL
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const chatUrl = isLocal 
        ? 'http://localhost:3000/chat' 
        : 'https://terrancehah.com/chat';

    // Build the URL with parameters
    const url = new URL(chatUrl);
    url.searchParams.set('city', city);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('language', language);
    url.searchParams.set('budget', budget);
    
    // Add each preference as a separate parameter
    travelPreferences.forEach((pref, index) => {
        url.searchParams.append('travel-preference[]', pref);
    });

    // Hide loading spinner before redirect
    document.getElementById("loadingSpinner").style.display = "none";

    // Redirect to chat page
    window.location.href = url.toString();
});