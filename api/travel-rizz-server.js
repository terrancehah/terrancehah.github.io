// previousPrompt= [
//     `Create a travel itinerary for ${req.body.city} from ${req.body.startDate} to ${req.body.endDate}. 
//     The itinerary should include the below aspects of the city of ${req.body.city}.
//     Introduction, Climate and Weather, Language, Population, Currency, Safety, Navigation, the itinerary itself, and finally the reminder.
//     Each aspect will take one section/paragraph. 

//     Also, the itinerary should be provided in a daily schedule form; for each day, arrange the schedule so that the traveller can get to 3-4 attractions. 
//     The attractions that are visited each day should not be too far, they should be in around the nearby area; if possible, briefly introduce a little how the traveller can get to all the attractions (by foot or public transport etc).
//     Remember not to provide the response in a dialogue or conversation form, instead you should reply in an informative and descriptive way.
//     Do not ever include the opening and closing tags of '''html, </ and ''' in the generated content.

//     Since the response here will be redirected to be shown on a HTML page, please format the response with HTML tags.
//     Use <h1>, <h2> for different headings accordingly, 
//     <strong> for different times in a day, 
//     <href> to replace the attractions with Google Map link or reputable websites hyperlinks, 
//     <href> hyperlinks to replace transports related websites, 
//     <href> hyperlinks to exchanges rate table of the destination country currency on x-rates.com, 
//     <br> for line breaks and <p> for paragraphs.
//     When it comes to hyperlink, you can replace the text(attraction, transport etc) in the paragraph into hyperlink.
//     Also, for every hyperlink, add the target="_blank" attribute in so that the link opens in another tab instead of replacing the current tab.
//     You must provide at least 2-3 hyperlinks for the schedule of each day.
//     The direct link to the exchange rate table of the currency, it should look something like this: https://www.x-rates.com/table/?from=CZK&amount=1 instead of a general x-rates.com homepage link. 

//     As for the tone and mood of your response, they should be passionate and informative.

//     Here's a template itinerary you can refer to: 

//     <h1>Welcome to Kuala Lumpur!</h1>
//     <p>Kuala Lumpur, the heart of Malaysia, is a dynamic city that beautifully intertwines tradition with modernity. Renowned for its diverse cultural heritage, it presents a unique experience that blends historical charm with contemporary advancements.</p>

//     <h2>Climate and Weather</h2>:<p>The city enjoys a tropical rainforest climate, characterized by hot and humid weather with abundant rainfall, especially during the monsoon seasons. As of recent weeks, Malaysia has been experiencing consecutives days of raining, achieving the average of 25mm daily rainfall in the past week.</p>

//     <h2>Language</h2>:<p>Bahasa Malaysia is the official language, but English is widely spoken, making it a tourist-friendly destination. The city's diverse population also speaks various other languages and dialects.</p>

//     <h2>Population</h2>:<p>Kuala Lumpur is home to approximately 1.8 million people, creating a bustling, vibrant urban environment.</p>

//     <h2>Currency</h2>:<p>The Malaysian Ringgit (MYR) is the official currency used in Kuala Lumpur. Stay updated with the latest exchange rates at <a href="https://www.x-rates.com/table/?from=MYR&amount=1" target="_blank">x-rates.com</a>.</p>

//     <h2>Safety</h2>:<p>Traverse Kuala Lumpur's streets with ease and assurance. The city is a safe haven for travelers, complemented by its extensive and user-friendly public transportation system.</p>

//     <h2>Navigating Kuala Lumpur</h2>:<p>Travel like a local using Kuala Lumpur's efficient MRT, LRT, and Monorail systems. Discover how easy it is to hop from one attraction to another with the comprehensive network detailed at <a href="https://www.myrapid.com.my/" target="_blank">MyRapid</a>.</p>

//     <h2>Three-Day Itinerary in Kuala Lumpur</h2> 
//     <p>For your three-day itinerary in Kuala Lumpur, here's a comprehensive guide that combines cultural exploration, iconic landmarks, and local experiences.</p>

//     <h3>Day 1: Exploring City Landmarks</h3>

//     <p><strong>Morning:</strong> Witness the architectural splendor of the  <a href="https://www.petronastwintowers.com.my/" target="_blank">Petronas Twin Towers</a>, a symbol of Malaysia's rapid growth and ambition.</p>
//     <p><strong>Afternoon:</strong> Indulge in a shopping and culinary extravaganza at the Suria KLCC, nestled at the feet of the majestic towers.</p>
//     <p><strong>Evening:</strong> Unwind amidst the verdant beauty of KLCC Park, an urban sanctuary offering a tranquil retreat from the city's hustle. Learn more about this urban oasis at <a href="https://www.suriaklcc.com.my/attractions/klcc-park/" target="_blank">KLCC Park</a>.</p>

//     <h3>Day 2: Cultural and Historical Exploration</h3>

//     <p><strong>Morning:</strong> Step back in time at the Sultan Abdul Samad Building and Merdeka Square, where the echoes of Malaysia's colonial history resonate.</p>
//     <p><strong>Afternoon:</strong> Delve into the heart of Kuala Lumpur's culture at the bustling Central Market and the vibrant streets of Chinatown, brimming with history and life.</p>
//     <p><strong>Evening:</strong> Immerse yourself in the electric atmosphere of Bukit Bintang, a dazzling hub of entertainment and nightlife.</p>
//     <p><strong>Night:</strong> Revel in the culinary paradise of Jalan Alor Night Market, where the aromas and flavors of Malaysian street food come alive under the stars.</p>

//     <h3>Day 3: Nature and Leisure</h3>

//     <p><strong>Morning:</strong> Engage with the avian world at the <a href="https://klbirdpark.com/" target="_blank">Kuala Lumpur Bird Park</a>, a sanctuary housing an astounding variety of bird species.</p>
//     <p><strong>Afternoon:</strong> Stroll through the  <a href="https://www.tripadvisor.com.my/Attraction_Review-g298570-d451263-Reviews-Perdana_Botanical_Garden-Kuala_Lumpur_Wilayah_Persekutuan.html" target="_blank">Perdana Botanical Gardenk</a> , where nature's splendor unfolds in the heart of the city.</p>
//     <p><strong>Evening:</strong> Cap off your adventure with panoramic city views from the Kuala Lumpur Tower's observation deck, witnessing the cityscape transform as dusk falls.</p>

//     <h2>Reminder</h2>
//     <p>Remember, the city's tropical climate means it can be hot and humid, so stay hydrated and carry a rain jacket for unexpected showers. Also, when crossing streets, be cautious as pedestrian signals can be unreliable, and drivers might not always yield to pedestrians.</p>

//     <p>Enjoy your Kuala Lumpur adventure!</p>
//     `
// ]
    

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
const cors = require('cors');

app.use(cors());

app.use(bodyParser.json());
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));

module.exports = async (req, res) => {
    if (req.method === 'POST') {
        const { city, startDate, endDate } = req.body;

        console.log("Received request for:", { city, startDate, endDate });

        try {
            const isLocal = process.env.NODE_ENV === 'development'; // Use 'development' for local

            console.log("NODE_ENV:", process.env.NODE_ENV);
            console.log("isLocal:", isLocal);

            const basicInfoURL = isLocal 
                ? 'http://localhost:3000/api/travel-rizz-basic-info' 
                : '/api/travel-rizz-basic-info';

            const detailsURL = isLocal 
                ? 'http://localhost:3000/api/travel-rizz-details' 
                : '/api/travel-rizz-details';

            const itineraryURL = isLocal 
                ? 'http://localhost:3000/api/travel-rizz-daily-itinerary' 
                : '/api/travel-rizz-daily-itinerary';

            // Then use these URLs in your axios calls
            const basicInfoPromise = axios.post(basicInfoURL, { city, startDate, endDate });
            const detailsPromise = axios.post(detailsURL, { city, startDate, endDate });
            const itineraryPromise = axios.post(itineraryURL, { city, startDate, endDate });

            // Use Promise.all to wait for all promises to resolve
            const [basicInfoResponse, detailsResponse, itineraryResponse] = await Promise.all([basicInfoPromise, detailsPromise, itineraryPromise]);

            // Combine responses
            const generatedContent = basicInfoResponse.data.response + detailsResponse.data.response + itineraryResponse.data.response;

            res.send({ generatedContent });
        } catch (error) {
            console.error("Error in processing request:", error);
            res.status(500).send("Error processing your request");
        }
    } else {
        res.status(405).send('Method Not Allowed');
    }
};

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
