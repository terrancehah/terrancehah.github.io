// travel-rizz-server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
const cors = require('cors');

// Language code mapping for better language support
const LANGUAGE_CODES = {
    'en': 'English',
    'es': 'Español',
    'fr': 'Français',
    'de': 'Deutsch',
    'it': 'Italiano',
    'zh': '简体中文',
    'ja': '日本語',
    'ko': '한국어'
};

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));

// Validate language code
const validateLanguage = (languageCode) => {
    if (!languageCode || !LANGUAGE_CODES[languageCode]) {
        return 'en'; // Default to English if invalid language code
    }
    return languageCode;
};

// Format request data for consistency
const formatRequestData = (language, city, startDate, endDate) => {
    return {
        language: validateLanguage(language),
        languageName: LANGUAGE_CODES[validateLanguage(language)],
        city: city || '',
        startDate: startDate || '',
        endDate: endDate || ''
    };
};

module.exports = async (req, res) => {
    if (req.method === 'POST') {
        const { language, city, startDate, endDate } = req.body;

        // Validate and format input data
        const formattedData = formatRequestData(language, city, startDate, endDate);
        
        console.log("Received request for:", formattedData);

        try {
            const isLocal = process.env.NODE_ENV !== 'production';
            const baseURL = isLocal ? 'http://localhost:3000/api' : 'https://terrancehah.com/api';

            // Define API endpoints
            const endpoints = {
                basicInfo: `${baseURL}/travel-rizz-basic-info`,
                details: `${baseURL}/travel-rizz-details`,
                itinerary: `${baseURL}/travel-rizz-daily-itinerary`,
                conclusion: `${baseURL}/travel-rizz-conclusion`
            };

            // Make concurrent API calls with formatted data
            const [basicInfoResponse, detailsResponse, itineraryResponse, conclusionResponse] = await Promise.all([
                axios.post(endpoints.basicInfo, formattedData),
                axios.post(endpoints.details, formattedData),
                axios.post(endpoints.itinerary, formattedData),
                axios.post(endpoints.conclusion, formattedData)
            ]);

            // Validate responses
            const responses = [basicInfoResponse, detailsResponse, itineraryResponse, conclusionResponse];
            for (const response of responses) {
                if (!response.data || !response.data.response) {
                    throw new Error('Invalid response format from API');
                }
            }

            // Combine responses
            const generatedContent = responses.map(r => r.data.response).join('');

            // Send success response
            res.json({ 
                generatedContent,
                language: formattedData.language,
                status: 'success'
            });

        } catch (error) {
            console.error("Error in processing request:", error);
            
            // Send detailed error response
            res.status(500).json({
                error: "Error processing your request",
                details: error.message,
                language: validateLanguage(language)
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