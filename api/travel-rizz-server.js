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
            const baseURL = process.env.NODE_ENV === 'development' 
                ? 'http://localhost:' 
                : 'https://terrancehah.com/api/';

            // Make separate API calls to track errors better
            let responses = {};
            try {
                responses.basicInfo = await axios.post(baseURL + '3002/travel-rizz-basic-info', 
                    { language, city, startDate, endDate });
            } catch (error) {
                throw new Error(`Basic Info API failed: ${error.message}`);
            }

            try {
                responses.details = await axios.post(baseURL + '3003/travel-rizz-details', 
                    { language, city });
            } catch (error) {
                throw new Error(`Details API failed: ${error.message}`);
            }

            try {
                responses.itinerary = await axios.post(baseURL + '3004/travel-rizz-daily-itinerary', 
                    { language, city, startDate, endDate });
            } catch (error) {
                throw new Error(`Itinerary API failed: ${error.message}`);
            }

            try {
                responses.conclusion = await axios.post(baseURL + '3005/travel-rizz-conclusion', 
                    { language, city, startDate, endDate });
            } catch (error) {
                throw new Error(`Conclusion API failed: ${error.message}`);
            }

            // Combine responses
            const generatedContent = [
                responses.basicInfo.data.response,
                responses.details.data.response,
                responses.itinerary.data.response,
                responses.conclusion.data.response
            ].join('\n');

            res.json({ generatedContent });

        } catch (error) {
            console.error("Error in processing request:", error);
            res.status(500).json({ 
                error: "Error processing your request",
                details: error.message,
                source: error.response?.data || 'Unknown error source',
                failedEndpoint: error.config?.url || 'Unknown endpoint'
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