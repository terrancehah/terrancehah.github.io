require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai');
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const cors = require('cors');

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));

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
                    `In ${language}, please create daily itinerary for a trip to ${city} from ${startDate} to ${endDate}.
                    
                    Response Intros:
                    Each day will take one div.
                    Provide the daily itinerary in a daily schedule form; do not respond in hourly format, separate every day into Morning, Afternoon, Evening and Night time sections.
                    The schedule for each time session should consist at least 4 sentences, keep them informative.
                    For each day, start a new div/section/page, plan the schedule so that the travellers can get to at least 3-4 attractions.
                    The attractions that are visited each day should not be too far, try to group attractions for each day in walkable distance or nearby area.
                    If possible, briefly introduce how the traveller can get to all the attractions (by foot or public transport, walkable distance, travel time etc).
                    Also, you can occasionally introduce high-rating famous restaurants or bars near the attractions.
                    Provide each day's itinerary in about 220 words in one page/div, the word count suitable for one single A4 page.


                    Response Format:
                    Since the response here will be redirected to be shown on a webpage, certain sections of the content will be formatted with HTML tags.
                    Remember, do not start or end the content with the opening and closing tags of '''html, </ or ''' in the generated content, simply start with <div class="page-break">.
                    Use <div class="page-break"><header><img id='logo' src='resources/TH-logo.png' alt='logo'/><h2 id='brand'>Travel-Rizz</h2><h2 id='header-slogan'>Travel-Rizz:Your Personalized Journey Awaits</h2></header> EVERY TIME you start a div, and </div> to end the div.
                    Use <h1> <h2> for different headings, and <strong> for different time sections in a day,
                    <href target="_blank"> to replace every attraction with Google Map link or reputable websites hyperlinks, and also to replace transports related website,
                    and <p> for content.
                    You must provide hyperlinks for every attraction in the daily schedule, use the link in the format of https://maps.app.goo.gl/TAfSA3zqcwvv2yE49 instead of https://goo.gl/maps/jZCgdakB8xp8KQ6D9, also,verify to make sure the links work.
                    Do not use <ul></ul> or <li></li> tags, as they do get misaligned when later exported into PDF.
                    
                    Response Tone:
                    Remember not to provide the response in a dialogue or conversation form, instead you should reply in an informative and descriptive way.
                    As for the tone and mood of the response, be passionate and friendly.
                    `}
                ],
                max_tokens: 2000
            });

            if (gptResponse && gptResponse.choices && gptResponse.choices.length > 0) {
                const itineraryContent = gptResponse.choices[0].message.content;
                console.log("Itinerary Content:", itineraryContent);
                res.send({ response: itineraryContent });
            } else {
                console.error("Unexpected OpenAI API response structure for itinerary:");
                res.status(500).send("The response from the API does not have the expected content for itinerary.");
            }
        } catch (error) {
            console.error("Error in fetching itinerary:", error);
            res.status(500).send("Error processing your itinerary request");
        }
    } else {
        res.status(405).send('Method Not Allowed for itinerary');
    }
};

const PORT = process.env.PORT || 3004; // Different port for this service
app.listen(PORT, () => console.log(`Itinerary Service running on port ${PORT}`));
