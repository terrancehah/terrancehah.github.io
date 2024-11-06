const axios = require('axios');

const generateMapsLink = async (placeName, city) => {
    try {
        // Include city name for better accuracy
        const searchQuery = `${placeName}, ${city}`;
        const response = await axios.get(
            `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(searchQuery)}&inputtype=textquery&fields=place_id,formatted_address&key=${process.env.GOOGLE_MAPS_API_KEY}`
        );

        if (response.data.candidates && response.data.candidates.length > 0) {
            const placeId = response.data.candidates[0].place_id;
            return `https://www.google.com/maps/place/?q=place_id:${placeId}`;
        }
        
        // Fallback to search URL
        return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchQuery)}`;
    } catch (error) {
        console.error('Error generating maps link:', error);
        return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(placeName)}`;
    }
};

module.exports = { generateMapsLink };