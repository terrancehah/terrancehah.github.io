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

        console.log("Received conclusion request for:", { language, city, startDate, endDate });

        try {
            const gptResponse = await openai.chat.completions.create({
                model: 'gpt-4o-2024-08-06',
                messages: [
                    {"role": "system", "content": "You are an knowledgeable friendly travel assistant specializing in creating detailed daily travel itineraries for cities worldwide."},
                    {"role": "user", "content": 
                    `In the language of code ${language}, please create travel reminders, emergency contacts, and Farewell Message for a trip to ${city} from ${startDate} to ${endDate}.
                    
                    Response Intros:
                    Each section will take one div.
                    First, make a div for the travel reminders, separate content into Travel Document and Visa Requirement, Tax Refund Procedures, Latest Current Issues and Advisories, Local Etiquette and Cultural Norms, and Health and Vaccination Record Requirement.
                    Then, do one div for Emergency Contacts. Provide emergency contact numbers, including local police, ambulance, and fire department and others. Then, provide 2-3 hospitals in the city along with their contacts and address.
                    In the same div, construct messages under the emergency contacts to remind users to be aware of the location and contact information of their respective embassies in the city. Attach the link https://www.embassy-worldwide.com/ in your message.
                    Lastly, Do one last div for the Farewell Messages consisting about 2-3 sentences, wishing travelers a wonderful journey and inviting them to share their experiences or feedback online if the itinerary is being helpful. 
                    Do not prompt travellers to call us, as we are only a travel itinerary helper, not a travel agency.
                    
                    Response Format:
                    Since the response here will be redirected to be shown on a webpage, certain sections of the content will be formatted with HTML tags.
                    Remember, do not start or end the content with the opening and closing tags of '''html, </ or ''' in the generated content.
                    Use <div class="page-break"><header><img id='logo' src='resources/TH-logo.png' alt='logo'/><h2 id='brand'>Travel-Rizz</h2><h2 id='header-slogan'>Travel-Rizz:Your Personalized Journey Awaits</h2></header> EVERY TIME you start a section/div, and </div> to end a section/div.
                    Use <h1>, <h2> and for different headings,
                    <href target="_blank"> to replace every related helpful website like governmental websites, and links to hospital maps,
                    and <p> for content and paragraphs.
                    Use <br> to break lines between each hospital.
                    For any link that utiilises Google Map, use the link in the format of https://maps.app.goo.gl/TAfSA3zqcwvv2yE49 instead of https://goo.gl/maps/jZCgdakB8xp8KQ6D9, also, verify to make sure the links work.
                    Do not use <ul></ul> or <li></li> tags, as they do get misaligned when later exported into PDF.
                    The direct link to the visa application, it should be governmental official website like this: https://mzv.gov.cz/jnp/en/information_for_aliens/visa_form/index.html instead of some general website link.
                    For the last page of Farewell Messages, no <h1> title needed, no <p></p> needed, just wrap all the farewell messages sentences into one <h2 id='conclusion'></h2>, use <br> to break lines between sentences if you have to.
                    
                    Response Tone:
                    Remember not to provide the response in a dialogue or conversation form, instead you should reply in an informative and descriptive way.
                    As for the tone and mood of your response, be passionate and friendly.
                    `}
                ],
                max_tokens: 1000
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
