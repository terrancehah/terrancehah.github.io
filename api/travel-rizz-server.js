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
        
        try {
            // Different URL construction for local vs production
            const isLocal = process.env.NODE_ENV === 'development';
            const baseURL = isLocal 
                ? 'http://localhost' // Local development
                : 'https://terrancehah.com/api'; // Production

            // Construct endpoints based on environment
            const endpoints = isLocal ? {
                basicInfo: `${baseURL}:3002/`,
                details: `${baseURL}:3003/`,
                itinerary: `${baseURL}:3004/`,
                conclusion: `${baseURL}:3005/`
            } : {
                basicInfo: `${baseURL}/travel-rizz-basic-info`,
                details: `${baseURL}/travel-rizz-details`,
                itinerary: `${baseURL}/travel-rizz-daily-itinerary`,
                conclusion: `${baseURL}/travel-rizz-conclusion`
            };

            let responses = {};
            try {
                console.log('Attempting Basic Info API call to:', endpoints.basicInfo);
                responses.basicInfo = await axios.post(endpoints.basicInfo, 
                    { language, city, startDate, endDate });
            } catch (error) {
                throw new Error(`Basic Info API failed: ${error.message}, URL: ${error.config?.url}`);
            }

            try {
                responses.details = await axios.post(endpoints.details, 
                    { language, city });
            } catch (error) {
                throw new Error(`Details API failed: ${error.message}, URL: ${error.config?.url}`);
            }

            try {
                responses.itinerary = await axios.post(endpoints.itinerary, 
                    { language, city, startDate, endDate });
            } catch (error) {
                throw new Error(`Itinerary API failed: ${error.message}, URL: ${error.config?.url}`);
            }

            try {
                responses.conclusion = await axios.post(endpoints.conclusion, 
                    { language, city, startDate, endDate });
            } catch (error) {
                throw new Error(`Conclusion API failed: ${error.message}, URL: ${error.config?.url}`);
            }

            // Log responses before combining
            console.log('Basic Info Response:', responses.basicInfo.data);
            console.log('Details Response:', responses.details.data);
            console.log('Itinerary Response:', responses.itinerary.data);
            console.log('Conclusion Response:', responses.conclusion.data);

            // Combine responses
            const generatedContent = [
                responses.basicInfo.data.response,
                responses.details.data.response,
                responses.itinerary.data.response,
                responses.conclusion.data.response
            ].join('\n');

            console.log('Final generated content:', generatedContent);

            res.json({ generatedContent });

        } catch (error) {
            console.error("Error in processing request:", error);
            console.error("Error details:", {
                message: error.message,
                response: error.response?.data,
                endpoint: error.config?.url
            });
                        
            res.status(500).json({ 
                error: "Error processing your request",
                details: error.message,
                source: error.response?.data || 'Unknown error source',
                failedEndpoint: error.config?.url || 'Unknown endpoint',
                environment: isLocal ? 'development' : 'production'
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