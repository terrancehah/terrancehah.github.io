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
            const baseURL = isLocal ? 'http://localhost:3000/api' : 'https://terrancehah.com/api/';

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

            // // Send success response
            // res.json({ 
            //     generatedContent,
            //     language: formattedData.language,
            //     status: 'success'
            // });

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