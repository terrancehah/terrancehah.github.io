require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai');
const { generateMapsLink } = require('../maps-util.js');
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const cors = require('cors');

app.get('/api/maps-key', (req, res) => {
    res.json({ key: process.env.GOOGLE_MAPS_API_KEY });
});

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));


const processItineraryContent = async (content, city) => {
    try {
        // Validate input content
        if (!content || typeof content !== 'string') {
            throw new Error('Invalid content provided');
        }

        // Find all attraction placeholders in the format {PLACE:Attraction Name}
        const placePattern = /\{PLACE:(.*?)\}/g;
        let processedContent = content;
        const matches = [...content.matchAll(placePattern)];

        // Replace each placeholder with a proper maps link
        for (const match of matches) {
            const placeName = match[1];
            if (!placeName) continue; // Skip if placeName is empty
            
            try {
                const mapsLink = await generateMapsLink(placeName, city);
                processedContent = processedContent.replace(
                    `{PLACE:${placeName}}`,
                    `<a href="${mapsLink}" target="_blank">${placeName}</a>`
                );
            } catch (err) {
                console.error(`Error generating maps link for ${placeName}:`, err);
                // Fallback to plain text if map link generation fails
                processedContent = processedContent.replace(
                    `{PLACE:${placeName}}`,
                    placeName
                );
            }
        }

        // Validate HTML structure
        const divPattern = /<div class="page-break">[\s\S]*?<\/div>/g;
        if (!divPattern.test(processedContent)) {
            // Wrap content in proper div if missing
            processedContent = `<div class="page-break"><header><img id='logo' src='resources/TH-logo.png' alt='logo'/><h2 id='brand'>Travel-Rizz</h2><h2 id='header-slogan'>Travel-Rizz:Your Personalized Journey Awaits</h2></header>${processedContent}</div>`;
        }

        // Clean up any malformed HTML
        processedContent = processedContent
            .replace(/\n/g, ' ') // Replace newlines with spaces
            .replace(/\s+/g, ' ') // Remove extra spaces
            .replace(/>\s+</g, '><') // Remove spaces between tags
            .trim(); // Remove leading/trailing whitespace

        return processedContent;
    } catch (error) {
        console.error('Error in processItineraryContent:', error);
        throw new Error('Failed to process itinerary content');
    }
};

module.exports = async (req, res) => {
    if (req.method === 'POST') {
        const { language, city, startDate, endDate } = req.body;

        console.log("Received itinerary request for:", { language, city, startDate, endDate });

        try {
            const gptResponse = await openai.chat.completions.create({
                model: 'gpt-4o-2024-08-06',
                messages: [
                    {"role": "system", "content": "You are an knowledgeable friendly travel assistant specializing in creating detailed daily travel itineraries for cities worldwide."},
                    {"role": "user", "content": 
                    `In the language of ${language}, please create daily itinerary for a trip to ${city} from ${startDate} to ${endDate}.
                    
                    Response Intros:
                    Each day will take one div.
                    For each day, start a new div/section/page, plan the schedule so that the travellers can get to 3-4 attractions.
                    Provide the daily itinerary in a daily schedule form; do not respond in hourly format, separate each day into Morning, Afternoon, Evening and Night time sections.
                    The itinerary for each time session should consist about 3 to 4 sentences, keep them informative.
                    The attractions that are visited each day should not be too far, try to group attractions for each day in walkable distance or nearby area.
                    If possible, briefly introduce how the traveller can get to all the attractions (by foot or public transport, walkable distance, travel time etc).
                    Also, you can occasionally introduce high-rating famous restaurants or bars near the attractions.
                    Provide each day's itinerary in about 200 words in one page/div, a word count slightly less than enough for one single A4 page.

                    Response Format:
                    The entire output, including the content and the headings should be in the language of ${language}.
                    Since the response will be redirected to be shown on a webpage, certain sections of the content will be formatted with some HTML tags.
                    Do not use the tags like '''html, </,  '\n' + or ''' in the generated content.
                    Use <div class="page-break"><header><img id='logo' src='resources/TH-logo.png' alt='logo'/><h2 id='brand'>Travel-Rizz</h2><h2 id='header-slogan'>Travel-Rizz:Your Personalized Journey Awaits</h2></header> EVERY TIME you start a div, and </div> to end the div.
                    Then, use <h1> <h2> for different headings, and <strong> for different time sections in a day,
                    <a href target="_blank"> to replace related website,
                    and <p> for content.
                    For each attraction in the itinerary, you need to provide in the format {PLACE:Attraction Name}.
                    Example: Start your morning at {PLACE:Tokyo Skytree}, then walk to {PLACE:Senso-ji Temple}.
                    Do not use <ul></ul> or <li></li> tags, as they do get misaligned when later exported into PDF.
                    
                    Response Tone:
                    Remember not to provide the response in a dialogue or conversation form, instead reply in an informative and descriptive way.
                    As for the tone and mood of the response, be passionate and friendly.
                    `}
                ],
                max_tokens: 15000
            });

            if (!gptResponse.choices?.[0]?.message?.content) {
                throw new Error('Invalid response from OpenAI API');
            }

            const rawContent = gptResponse.choices[0].message.content;
            const processedContent = await processItineraryContent(rawContent, city);
            console.log("Itinerary Content:", processedContent);

            res.json({ response: processedContent });
        } catch (error) {
            console.error("Error in fetching itinerary:", error);
            res.status(500).json({ 
                error: "Error processing your itinerary request",
                details: error.message 
            });
        }
    } else {
        res.status(405).json({ error: 'Method Not Allowed for itinerary' });
    }
};

const PORT = process.env.PORT || 3004; // Different port for this service
app.listen(PORT, () => console.log(`Itinerary Service running on port ${PORT}`));
