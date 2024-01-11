require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai');const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const cors = require('cors');

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.send('Welcome to Travel-Rizz');
});

app.post('/generate_itinerary', async (req, res) => {
    const { city, startDate, endDate } = req.body;

    console.log("Received request for:", { city, startDate, endDate });

    try {
        const gptResponse = await openai.chat.completions.create({
            model: 'gpt-4-1106-preview',
            messages: [
                {"role": "system", "content": "You are a helpful travel assistant that can create travel plans for different cities."},
                {"role": "user", "content": `Create a travel plan for ${req.body.city} from ${req.body.startDate} to ${req.body.endDate}. 
                The itinerary should include a brief description of the city of ${req.body.city}, what the city is famous for, and the current travel trend in the city. 
                Also, provide the itinerary in daily schedule form, for each day, arrange the schedule so that the traveller can get to 3-4 attractions. 
                The attractions that are visited each day should not be too far, and if possible, briefly introduce how the traveller can get to all the attractions(by foot or public transport etc).
                Remember not to provide the response in a dialogue or conversation form, instead you should reply in an informative and descriptive way.
                Also, since the response here will be redirected to be shown on a HTML page, please format the response with HTML tags. Use <h1>, <h2> for different headings accordingly, <br> for line breaks and <p> for paragraphs.

                Here's a template itinerary to help you: 
                "Introduction to Kuala Lumpur
                Kuala Lumpur, the heart of Malaysia, is a dynamic city that beautifully intertwines tradition with modernity. Renowned for its diverse cultural heritage, it presents a unique experience that blends historical charm with contemporary advancements.
                
                Climate and Weather
                The city enjoys a tropical rainforest climate, characterized by hot and humid weather with abundant rainfall, especially during the monsoon seasons.
                
                Language
                Bahasa Malaysia is the official language, but English is widely spoken, making it a tourist-friendly destination. The city's diverse population also speaks various other languages and dialects.
                
                Population
                Kuala Lumpur is home to approximately 1.8 million people, creating a bustling, vibrant urban environment.
                
                Currency
                The Malaysian Ringgit (MYR) is the official currency used in Kuala Lumpur.
                
                Safety and Travel Convenience
                While Kuala Lumpur is relatively safe for travelers, standard safety precautions should be taken. The city boasts an efficient public transport network, including MRT, LRT, and Monorail, alongside taxis and ride-hailing services like Grab.
                
                Navigating Kuala Lumpur
                The city's public transport system provides easy access to major attractions and areas, making it convenient for travelers to explore. Knowing local customs and practices can enhance the travel experience.
                
                For your three-day itinerary in Kuala Lumpur, here's a comprehensive guide that combines cultural exploration, iconic landmarks, and local experiences.
                
                Day 1: Exploring City Landmarks
                
                Morning: Start your day with a visit to the iconic Petronas Twin Towers, the world's tallest twin towers. Enjoy breathtaking views of the city from the observation deck and the Skybridge.
                Afternoon: Explore the Suria KLCC, a high-end shopping mall at the base of the towers, where you can indulge in some shopping and dining.
                Evening: Visit the nearby KLCC Park, a 17-acre green space, perfect for an evening stroll or relaxation.
                Day 2: Cultural and Historical Exploration
                
                Morning: Head to the historical Sultan Abdul Samad Building and Merdeka Square to witness the city's colonial past.
                Afternoon: Explore the vibrant Central Market and nearby Chinatown for unique crafts, street food, and a bustling atmosphere.
                Evening: Experience the nightlife in Bukit Bintang, the city's entertainment and shopping hub, filled with lively bars and restaurants.
                Day 3: Nature and Leisure
                
                Morning: Visit the Kuala Lumpur Bird Park, a renowned eco-tourism park housing thousands of birds.
                Afternoon: Take a relaxing walk in the Perdana Botanical Garden, a lush green escape within the city.
                Evening: Conclude your trip with a visit to the observation deck of the Kuala Lumpur Tower for a panoramic view of the city at sunset.
                Throughout your stay, for convenience and to experience the city like a local, use the efficient public transport system. The Kuala Lumpur Monorail and LRT services are great options for navigating between attractions.
                
                Remember, the city's tropical climate means it can be hot and humid, so stay hydrated and carry a rain jacket for unexpected showers. Also, when crossing streets, be cautious as pedestrian signals can be unreliable, and drivers might not always yield to pedestrians."  `
                }
            ],
            max_tokens: 1200
        });

         // Log the entire response for debugging
        // console.log("OpenAI API Response:", JSON.stringify(gptResponse, null, 2));
        // console.log(typeof gptResponse);
        // console.log("Choices:", gptResponse.choices);



        // Extract the generated content from the response
        if (gptResponse && gptResponse.choices && gptResponse.choices.length > 0) {
            const generatedContent = gptResponse.choices[0].message.content;
            console.log("Generated Content:", generatedContent);
            res.send({ response: generatedContent });
        } else {
            console.error("Unexpected OpenAI API response structure:");
            res.status(500).send("The response from the API does not have the expected content.");
        }        
    } catch (error) {
        console.error("Error details:", error);
        res.status(500).send("Error processing your request");
    }
});




const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
