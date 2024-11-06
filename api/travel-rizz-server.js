// travel-rizz-server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
const cors = require('cors');

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));


module.exports = async (req, res) => {
    if (req.method === 'POST') {
        const { language, city, startDate, endDate } = req.body;
        
        console.log("Received request for:", formattedData);

        try {
             // Base URL configuration
            const baseURL = 'https://terrancehah.com/api/';

             // Make API calls
            const [basicInfoResponse, detailsResponse, itineraryResponse, conclusionResponse] = await Promise.all([
                axios.post(baseURL + 'travel-rizz-basic-info', { language, city, startDate, endDate }),
                axios.post(baseURL + 'travel-rizz-details', { language, city }),
                axios.post(baseURL + 'travel-rizz-daily-itinerary', { language, city, startDate, endDate }),
                axios.post(baseURL + 'travel-rizz-conclusion', { language, city, startDate, endDate })
            ]);

             // Combine responses
            const generatedContent = [
                basicInfoResponse.data.response,
                detailsResponse.data.response,
                itineraryResponse.data.response,
                conclusionResponse.data.response
            ].join('');

            res.json({ generatedContent });

        } catch (error) {
            console.error("Error in processing request:", error);
            res.status(500).json({ 
                error: "Error processing your request",
                details: error.message
            });
        }
    } else {
        res.status(405).json({ 
            error: 'Method Not Allowed',
            allowedMethods: ['POST']
        });
    }
};

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));