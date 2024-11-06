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
        const { language, city } = req.body;

        console.log("Received detailed info request for:", language, city);

        try {
            const gptResponse = await openai.chat.completions.create({
                model: 'gpt-4o-2024-08-06',
                messages: [
                    {"role": "system", "content": "You are a knowledgeable friendly travel assistant providing detailed information about specific aspects of travel destinations for travel purpose."},
                    {"role": "user", "content": 
                    `In the language of code ${language}, provide details about currency information, safety tips, business operating hours and local navigation for travelers in ${city}.
                    
                    Response Intros:
                    Each aspect will take one section/paragraph, at most 2-3 sentences.
                    Provide all these information in about 220 words in one page/div, the word count suitable for one single A4 page.

                    Response Format:
                    Since the response here will be redirected to be shown on a webpage, certain sections of the content will be formatted with HTML tags.
                    Do not ever start or end the div with the opening and closing HTML tags of '''html, </ or ''', simply start with <div class="page-break">.
                    Use <div class="page-break"><header><img id='logo' src='resources/TH-logo.png' alt='logo'/><h2 id='brand'>Travel-Rizz</h2><h2 id='header-slogan'>Travel-Rizz:Your Personalized Journey Awaits</h2></header> and </div> to start and end the section/div.
                    Use <h1>Notable Details about (name of the city)</h1>, then <h2> for different headings accordingly, 
                    <href target="_blank"> hyperlinks to replace the transports related websites, 
                    <href target="_blank"> hyperlinks to exchanges rate table of the destination country currency on x-rates.com.
                    The direct link to the exchange rate table of the currency, it should look like: https://www.x-rates.com/table/?from=CZK&amount=1 instead of a general x-rates.com homepage link.
                    Use <p> for paragraphs, then finally ending with a </div> tag to signify the end of the section/div.

                    
                    Response Tone:
                    Remember not to provide the response in a dialogue or conversation form, instead reply in an informative and concise way.
                    As for the tone and mood of your response, be passionate and friendly.
                    `}
                ],
                max_tokens: 1000
            });

            if (gptResponse && gptResponse.choices && gptResponse.choices.length > 0) {
                const detailedInfoContent = gptResponse.choices[0].message.content;
                console.log("Detailed Info Content:", detailedInfoContent);
                res.send({ response: detailedInfoContent });
            } else {
                console.error("Unexpected OpenAI API response structure for detailed info:");
                res.status(500).send("The response from the API does not have the expected content for detailed info.");
            }
        } catch (error) {
            console.error("Error in fetching detailed info:", error);
            res.status(500).send("Error processing your detailed info request");
        }
    } else {
        res.status(405).send('Method Not Allowed for detailed info');
    }
};

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`Detailed Info Service running on port ${PORT}`));
