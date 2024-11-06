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
        
        // console.log("Received request for:", formattedData);

        try {
             // Use localhost URLs in development
            const baseURL = process.env.NODE_ENV === 'development' 
            ? 'http://localhost:' 
            : 'https://terrancehah.com/api/';

            // Make API calls with better error handling
            const [basicInfoResponse, detailsResponse, itineraryResponse, conclusionResponse] = await Promise.all([
                axios.post(baseURL + '3002/travel-rizz-basic-info', { language, city, startDate, endDate }),
                axios.post(baseURL + '3003/travel-rizz-details', { language, city }),
                axios.post(baseURL + '3004/travel-rizz-daily-itinerary', { language, city, startDate, endDate }),
                axios.post(baseURL + '3005/travel-rizz-conclusion', { language, city, startDate, endDate })
            ]);

            // Verify each response has the expected data
            if (!basicInfoResponse.data.response || !detailsResponse.data.response || 
                !itineraryResponse.data.response || !conclusionResponse.data.response) {
                throw new Error('Invalid response from one of the services');
            }

             // Combine responses
            const generatedContent = [
                basicInfoResponse.data.response,
                detailsResponse.data.response,
                itineraryResponse.data.response,
                conclusionResponse.data.response
            ].join('\n');  // just add newline

            res.json({ generatedContent });

        } catch (error) {
            console.error("Error in processing request:", error);
            res.status(500).json({ 
                error: "Error processing your request",
                details: error.message,
                source: error.response?.data || 'Unknown error source'
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