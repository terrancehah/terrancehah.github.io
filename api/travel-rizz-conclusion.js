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

        // Find all location placeholders in the format {PLACE:Place Name}
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

        console.log("Received conclusion request for:", { language, city, startDate, endDate });

        try {
            const gptResponse = await openai.chat.completions.create({
                model: 'gpt-4o-2024-08-06',
                messages: [
                    {"role": "system", "content": "You are an knowledgeable friendly travel assistant specializing in creating detailed daily travel itineraries for cities worldwide."},
                    {"role": "user", "content": 
                    `In the language of ${language}, please create travel reminders, emergency contacts, and Farewell Message for a trip to ${city} from ${startDate} to ${endDate}.
                    
                    Response Intros:
                    Each section will take one div.
                    First, make a div for the travel reminders, separate content into Travel Document and Visa Requirement, Tax Refund Procedures, Latest Current Issues and Advisories, Local Etiquette and Cultural Norms, and Health and Vaccination Record Requirement.
                    Then, do another div for Emergency Contacts. Provide emergency contact numbers, including local police, ambulance, and fire department and others necessary contacts. Then, provide 2-3 hospitals in the city along with their contacts and address.
                    In the same div, construct messages under the emergency contacts to remind users to be aware of the location and contact information of their respective embassies in the city. Attach the link https://www.embassy-worldwide.com/ in your message.
                    Lastly, Do one last div for the Farewell Messages consisting about 2-3 sentences, wishing travelers a wonderful journey and inviting them to share their experiences or feedback online if the itinerary is being helpful. 
                    Do not prompt travellers to call us, as we are only a travel itinerary helper, not a travel agency.
                    End the message with one last line: #travelrizz
                    
                    Response Format:
                    The entire output, including the content and the headings should be in the language of ${language}.
                    Since the response here will be redirected to be shown on a webpage, certain sections of the content will be formatted with some HTML tags.
                    Do not use the tags like '''html, </,  '\n' + or ''' in the generated content.
                    Use <div class="page-break"><header><img id='logo' src='resources/TH-logo.png' alt='logo'/><h2 id='brand'>Travel-Rizz</h2><h2 id='header-slogan'>Travel-Rizz:Your Personalized Journey Awaits</h2></header> EVERY TIME you start a section/div/page.
                    Then use </div> to end the section/div/page.
                    Use <h1>, <h2> and for different headings, and <p> for content and paragraphs.
                    Use <br> to break lines between each hospital.
                    <a href target="_blank"> to replace every related helpful website like governmental websites.
                    For links to hospital maps, provide in the format {PLACE:Hospital Name}.
                    Do not use <ul></ul> or <li></li> tags, as they do get misaligned when later exported into PDF.
                    The direct link to the visa application, it should be governmental official website like this: https://mzv.gov.cz/jnp/en/information_for_aliens/visa_form/index.html wrapped in the href.
                    For the last div/page of Farewell Messages, do not use <h1></h1> or <p></p>, wrap all the farewell messages sentences into one <h2 id='conclusion'></h2>, use <br> to break lines between sentences if needed.
                    
                    Response Tone:
                    Remember not to provide the response in a dialogue or conversation form, instead reply in an informative and descriptive way.
                    As for the tone and mood of your response, be passionate and friendly.
                    `}
                ],
                max_tokens: 1000
            });

            if (!gptResponse.choices?.[0]?.message?.content) {
                throw new Error('Invalid response from OpenAI API');
            }
            const rawContent = gptResponse.choices[0].message.content;
            const processedContent = await processItineraryContent(rawContent, city);
            console.log("Conclusion Content:", processedContent);
            
            res.json({ response: processedContent });
        } catch (error) {
            console.error("Error in fetching conclusion:", error);
            res.status(500).json({ 
                error: "Error processing your conclusion request",
                details: error.message 
            });        }
    } else {
        res.status(405).send('Method Not Allowed for conclusion');
    }
};

const PORT = process.env.PORT || 3005; // Different port for this service
app.listen(PORT, () => console.log(`Itinerary Service running on port ${PORT}`));
