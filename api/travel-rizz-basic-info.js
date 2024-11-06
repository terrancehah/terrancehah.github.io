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

        console.log("Received basic info request for:", { language, city, startDate, endDate });

        try {
            const gptResponse = await openai.chat.completions.create({
                model: 'gpt-4o-2024-08-06',
                messages: [
                    {"role": "system", "content": "You are a knowledgeable travel assistant focused on providing basic information about cities for travel purposes."},
                    {"role": "user", "content": 
                    `In the language of code ${language}, provide an introduction of ${city}, information about the season, climate and weather during the period from ${startDate} to ${endDate}, the languages spoken, and the population.
                    
                    Response Intros:
                    Each aspect will take one section/paragraph, and made up by 2 to 4 sentences.
                    Provide all these information in about 220 words in one page/div, the word count suitable for one single A4 page.
                    
                    Response Format:
                    Since the response here will be redirected to be shown on a webpage, certain sections of the content will be formatted with HTML tags.
                    Remember, do not start or end the content with the opening and closing tags of '''html, </ or ''' in the generated content.
                    Use <div class="page-break"><header><img id='logo' src='resources/TH-logo.png' alt='logo'/><h2 id='brand'>Travel-Rizz</h2><h2 id='header-slogan'>Travel-Rizz:Your Personalized Journey Awaits</h2></header> and </div> EVERY TIME you start and end a whole page/section/div.
                    For the content inside, start with <h1>Welcome to (the name of the city)!</h1>, then <h2> for the following headings/aspects accordingly, 
                    <href target="_blank"> to insert weather related websites for the city during the period and other relative informations,
                    and <p> for paragraphs.
                    The direct link to the monthly weather forecast for the city, it should look like: https://www.accuweather.com/en/at/vienna/31868/october-weather/31868?year=2024 instead of a general accuweather.com homepage link.


                    Response Tone:
                    Remember not to provide the response in a dialogue or conversation form, instead reply in an informative and concise way.
                    As for the tone and mood of your response, be passionate and friendly.
                    `}
                ],
                max_tokens: 700
            });

            if (gptResponse && gptResponse.choices && gptResponse.choices.length > 0) {
                const basicInfoContent = gptResponse.choices[0].message.content;
                console.log("Basic Info Content:", basicInfoContent);
                res.send({ response: basicInfoContent });
            } else {
                console.error("Unexpected OpenAI API response structure for basic info:");
                res.status(500).send("The response from the API does not have the expected content for basic info.");
            }
        } catch (error) {
            console.error("Error in fetching basic info:", error);
            res.status(500).send("Error processing your basic info request");
        }
    } else {
        res.status(405).send('Method Not Allowed for basic info');
    }
};

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Basic Info Service running on port ${PORT}`));
