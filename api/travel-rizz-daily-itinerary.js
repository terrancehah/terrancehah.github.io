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
                    {"role": "system", "content": "You are an AI specializing in creating detailed daily travel itineraries for cities worldwide."},
                    {"role": "user", "content": 
                    `Please create a daily itinerary for a trip to ${city} from ${startDate} to ${endDate}.
                    Each aspect will take one section/paragraph.
                    Also, the itinerary should be provided in a daily schedule form; do not respond in hourly format, separate every day into Morning, Afternoon, Evening should be enough.
                    If possible, include Night for night activities.
                    The schedule for each time session should be at most 2-3 sentences, keep them concise and informative.
                    For each day, plan the schedule so that the traveller can get to 3-4 attractions.
                    The attractions that are visited each day should not be too far, they should be in around the nearby area; if possible, briefly introduce a little how the traveller can get to all the attractions (by foot or public transport etc).
                    Remember not to provide the response in a dialogue or conversation form, instead you should reply in an informative and descriptive way.
                    Do not ever include the opening and closing tags of '''html, </ and ''' in the generated content.
                    Since the response here will be redirected to be shown on a HTML page, you must format each section with HTML tags.
                    Use <div class="page-break"><header><img id='logo' src='resources/TH-logo.png' alt='logo'/><h2 id='brand'>Travel-Rizz</h2><h2 id='header-slogan'>Travel-Rizz:Your Personalized Journey Awaits</h2></header> and </div> to start and end the content for each day, and also for the travel reminder alone.
                    Limit the content for each page to about 3000 characters.
                    Use <h1>, <h2> for different headings,
                    <strong> for different times in a day,
                    <href target="_blank"> to replace the attractions with Google Map link or reputable websites hyperlinks,
                    <href target="_blank"> hyperlinks to replace transports related websites,
                    and <p> for captions and paragraphs.
                    You must provide at least 3 hyperlinks for the schedule of each day.
                    Provide the itinerary with each day's schedule in a format suitable for a single page, then end each day's schedule with a <br> tag for a page break.
                    Lastly, for the travel reminder part, make a <h1> heading, then separate content into reminder list of Travel Document, Tax refund, Latest Current Issue and so on.
                    The direct link to the visa application, it should look like this: https://mzv.gov.cz/jnp/en/information_for_aliens/visa_form/index.html instead of some general website link.
                    Do this too to the remaining links if possible.
                    As for the tone and mood of your response, they should be passionate and friendly.
                    `}
                ],
                max_tokens: 1500
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
