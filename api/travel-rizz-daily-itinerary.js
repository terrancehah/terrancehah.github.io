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
        const { city, startDate, endDate } = req.body;

        console.log("Received itinerary request for:", { city, startDate, endDate });

        try {
            const gptResponse = await openai.chat.completions.create({
                model: 'gpt-4-1106-preview',
                messages: [
                    {"role": "system", "content": "You are an knowledgeable friendly travel assistant specializing in creating detailed daily travel itineraries for cities worldwide."},
                    {"role": "user", "content": 
                    `Please create daily itinerary for a trip to ${city} from ${startDate} to ${endDate}.
                    
                    Response Intros:
                    Each day will take one div/page.
                    Provide the daily itinerary a daily schedule form; do not respond in hourly format, separate every day into Morning, Afternoon, Evening and Night time sections.
                    The schedule for each time session should be at least 3-4 sentences, keep them informative.
                    For each day, start a new div/section/page, plan the schedule so that the travellers can get to at least 3-4 attractions.
                    The attractions that are visited each day should not be too far, try to group attractions for each day in around the nearby area; if possible, briefly introduce a little how the traveller can get to all the attractions (by foot or public transport etc).
                    Provide each day's itinerary in a total word count suitable for a single A4 page, about 200-250 words max per page/div.
                    
                    Response Format:
                    Since the response here will be redirected to be shown on a HTML page, you must format each section with HTML tags.
                    Do not ever start or end the content with the opening and closing tags of '''html, </ and ''' in the generated content, just start with <div class="page-break">.
                    Use <div class="page-break"><header><img id='logo' src='resources/TH-logo.png' alt='logo'/><h2 id='brand'>Travel-Rizz</h2><h2 id='header-slogan'>Travel-Rizz:Your Personalized Journey Awaits</h2></header> EVERY TIME you start a page/section/div, and </div> to end a page/section/div.
                    Use <h1>, <h2> for different headings,
                    <strong> for different times in a day,
                    <href target="_blank"> to replace every attraction with Google Map link or reputable websites hyperlinks, and also to replace transports related website,
                    and <p> for content.
                    You must provide hyperlinks for every attraction in the daily schedule.
                    Do not use <ul></ul> or <li></li> tags, as they do get misaligned when later exported into PDF.

                    
                    Response Tone:
                    Remember not to provide the response in a dialogue or conversation form, instead you should reply in an informative and descriptive way.
                    As for the tone and mood of your response, try to be passionate and friendly.
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
