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
        const { city } = req.body;

        console.log("Received detailed info request for:", city);

        try {
            const gptResponse = await openai.chat.completions.create({
                model: 'gpt-4-1106-preview',
                messages: [
                    {"role": "system", "content": "You are a knowledgeable travel assistant providing detailed information about specific aspects of travel destinations."},
                    {"role": "user", "content": 
                    `Can you provide details about currency information, safety tips, business operating hours and local navigation for travelers in ${city}?
                    Each aspect will take one section/paragraph, at most 2-3 sentences.
                    Remember not to provide the response in a dialogue or conversation form, instead reply in an informative and concise way.
                    Do not include the opening and closing tags of '''html, </ and ''' in the generated content.
                    Since the response here will be redirected to be shown on a HTML page, please format the response with HTML tags.
                    Use <div class="page-break"><header><img id='logo' src='resources/TH-logo.png' alt='logo'/><h2 id='brand'>Travel-Rizz</h2><h2 id='header-slogan'>Travel-Rizz:Your Personalized Journey Awaits</h2></header> and </div> to start and end the whole content, limited to about 3000 characters.
                    Use <h1>Notable Details about ${city}</h1>, then <h2> for different headings accordingly, 
                    <href target="_blank"> hyperlinks to replace transports related websites, 
                    <href target="_blank"> hyperlinks to exchanges rate table of the destination country currency on x-rates.com, 
                    and <p> for paragraphs.
                    Provide this information in a format suitable for a single page, then finally ending with a <br> tag to signify a page break.
                    The direct link to the exchange rate table of the currency, it should look like this: https://www.x-rates.com/table/?from=CZK&amount=1 instead of a general x-rates.com homepage link.
                    `}
                ],
                max_tokens: 700
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
