require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
const cors = require('cors');

app.use(cors());

app.use(bodyParser.json());
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));

module.exports = async (req, res) => {
    if (req.method === 'POST') {
        const { language, city, startDate, endDate } = req.body;

        console.log("Received request for:", { language, city, startDate, endDate });

        try {
            const isLocal = process.env.NODE_ENV !== 'production';

            const basicInfoURL = isLocal 
                ? 'http://localhost:3000/api/travel-rizz-basic-info' 
                : 'https://terrancehah.com/api/travel-rizz-basic-info';

            const detailsURL = isLocal 
                ? 'http://localhost:3000/api/travel-rizz-details' 
                : 'https://terrancehah.com/api/travel-rizz-details';

            const itineraryURL = isLocal 
                ? 'http://localhost:3000/api/travel-rizz-daily-itinerary' 
                : 'https://terrancehah.com/api/travel-rizz-daily-itinerary';

            const conclusionURL = isLocal
                ? 'http://localhost:3000/api/travel-rizz-conclusion' 
                : 'https://terrancehah.com/api/travel-rizz-conclusion';

            // Then use these URLs in your axios calls
            const basicInfoPromise = axios.post(basicInfoURL, { language, city, startDate, endDate });
            const detailsPromise = axios.post(detailsURL, { language, city, startDate, endDate });
            const itineraryPromise = axios.post(itineraryURL, { language, city, startDate, endDate });
            const conclusionPromise = axios.post(conclusionURL, { language, city, startDate, endDate });

            // Use Promise.all to wait for all promises to resolve
            const [basicInfoResponse, detailsResponse, itineraryResponse, conclusionReponse] = await Promise.all([basicInfoPromise, detailsPromise, itineraryPromise, conclusionPromise]);

            // Combine responses
            const generatedContent = basicInfoResponse.data.response + detailsResponse.data.response + itineraryResponse.data.response + conclusionReponse.data.response;

            res.send({ generatedContent });
        } catch (error) {
            console.error("Error in processing request:", error);
            res.status(500).send("Error processing your request");
        }
    } else {
        res.status(405).send('Method Not Allowed');
    }
};

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
