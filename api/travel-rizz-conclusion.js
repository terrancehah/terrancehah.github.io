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

        console.log("Received conclusion request for:", { city, startDate, endDate });

        try {
            const gptResponse = await openai.chat.completions.create({
                model: 'gpt-4-1106-preview',
                messages: [
                    {"role": "system", "content": "You are an knowledgeable friendly travel assistant specializing in creating detailed daily travel itineraries for cities worldwide."},
                    {"role": "user", "content": 
                    `Please create travel reminders, emergency contacts, and Farewell Message for a trip to ${city} from ${startDate} to ${endDate}.
                    
                    Response Intros:
                    Each section will take one div/page.
                    First, make a page/div for the travel reminders, separate content into Travel Document and Visa Requirement, Tax Refund Procedures, Latest Current Issues and Advisories, Local Etiquette and Cultural Norms, and Health and Vaccination Record Requirement.
                    Then, do one page/div for Emergency Contacts. Provide emergency contact numbers, including local police, ambulance, and fire department and so on. Then, provide 2-4 hospitals in the city along with their contacts and address.
                    In the same div/page, construct messages under the emergency contacts to remind users to be aware of the location and contact information of their respective embassies in the city. Attach the link https://www.embassy-worldwide.com/ in your message.
                    Lastly, Do one last page/div for the Farewell Messages, wishing travelers a wonderful journey and inviting them to share their experiences or feedback.
                    
                    Response Format:
                    Since the response here will be redirected to be shown on a HTML page, you must format each section with HTML tags.
                    Do not ever include the opening and closing tags of '''html, </ and ''' in the generated content.
                    Use <div class="page-break"><header><img id='logo' src='resources/TH-logo.png' alt='logo'/><h2 id='brand'>Travel-Rizz</h2><h2 id='header-slogan'>Travel-Rizz:Your Personalized Journey Awaits</h2></header> EVERY TIME you start a page/section/div, and </div> to end a page/section/div.
                    Use <h1>, <h2> and for different headings,
                    <href target="_blank"> to replace every related helpful website like governmental websites, and links to hospital maps.
                    and <p> for content and paragraphs.
                    Do not use <ul></ul> or <li></li> tags, as they do get misaligned when later exported into PDF.
                    The direct link to the visa application, it should be government-related official website like this: https://mzv.gov.cz/jnp/en/information_for_aliens/visa_form/index.html instead of some general website link.
                    Do this too to the other links as well.
                    For the last page of Farewell Messages, no <h1> title needed, no <p></p> needed, just wrap all the farewell messages sentences into one <h2 id='conclusion'></h2>, you can try <br> to break lines between sentences if you have to.
                    
                    Response Tone:
                    Remember not to provide the response in a dialogue or conversation form, instead you should reply in an informative and descriptive way.
                    As for the tone and mood of your response, try to be passionate and friendly.
                    `}
                ],
                max_tokens: 1500
            });

            if (gptResponse && gptResponse.choices && gptResponse.choices.length > 0) {
                const itineraryContent = gptResponse.choices[0].message.content;
                console.log("Itinerary Content:", itineraryContent);
                res.send({ response: itineraryContent });
            } else {
                console.error("Unexpected OpenAI API response structure for conclusion:");
                res.status(500).send("The response from the API does not have the expected content for conclusion.");
            }
        } catch (error) {
            console.error("Error in fetching conclusion:", error);
            res.status(500).send("Error processing your conclusion request");
        }
    } else {
        res.status(405).send('Method Not Allowed for conclusion');
    }
};

const PORT = process.env.PORT || 3005; // Different port for this service
app.listen(PORT, () => console.log(`Itinerary Service running on port ${PORT}`));
