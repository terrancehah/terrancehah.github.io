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
        const isLocal = process.env.NODE_ENV === 'development';
        
        try {
            // Different URL construction for local vs production
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

            // Function to validate response
            const validateResponse = (response, endpoint) => {
                console.log(`Raw ${endpoint} response:`, response.data);

                // Add detailed logging of the response
                console.log(`${endpoint} response content:`, {
                    responseData: response.data,
                    responseType: typeof response.data,
                    hasResponse: 'response' in response.data,
                    responseContentType: typeof response.data.response
                });

                // Clean the response string of html prefix/tags and code blocks
                if (response.data.response) {
                    response.data.response = response.data.response
                        .replace(/^html\s+/, '')  // Remove 'html ' prefix
                        .replace(/```html\n|```/g, '')  // Remove code block markers
                        .replace(/\n\s+\+\s+/g, '')  // Remove line concatenation
                        .trim();  // Clean up any extra whitespace
                }

                return response;
            };

            // Basic Info
            try {
                console.log('Calling Basic Info API:', endpoints.basicInfo);
                responses.basicInfo = await axios.post(endpoints.basicInfo, 
                    { language, city, startDate, endDate });
                if (responses.basicInfo.data.response.includes('```')) {
                    responses.basicInfo.data.response = responses.basicInfo.data.response
                        .replace(/```html\n|```/g, '')
                        .replace(/\n\s+\+\s+/g, '');
                }
                validateResponse(responses.basicInfo, 'basicInfo');
            } catch (error) {
                console.error('Basic Info API error:', error.response?.data || error.message);
                throw new Error(`Basic Info API failed: ${error.message}`);
            }

            // Details
            try {
                console.log('Calling Details API:', endpoints.details);
                responses.details = await axios.post(endpoints.details, 
                    { language, city });
                if (responses.details.data.response.includes('```')) {
                    responses.details.data.response = responses.details.data.response
                        .replace(/```html\n|```/g, '')
                        .replace(/\n\s+\+\s+/g, '');
                }
                validateResponse(responses.details, 'details');
            } catch (error) {
                console.error('Details API error:', error.response?.data || error.message);
                throw new Error(`Details API failed: ${error.message}`);
            }

            // Itinerary
            try {
                console.log('Calling Itinerary API:', endpoints.itinerary);
                responses.itinerary = await axios.post(endpoints.itinerary, 
                    { language, city, startDate, endDate }, 
                    { 
                        maxBodyLength: Infinity,
                        maxContentLength: Infinity 
                    }
                );
                if (responses.itinerary.data.response.includes('```')) {
                    responses.itinerary.data.response = responses.itinerary.data.response
                        .replace(/```html\n|```/g, '')
                        .replace(/\n\s+\+\s+/g, '');
                }
                validateResponse(responses.itinerary, 'itinerary');
            } catch (error) {
                console.error('Itinerary API error:', error.response?.data || error.message);
                console.error('Itinerary API error details:', {
                    message: error.message,
                    code: error.code,
                    responseSize: error.response?.data ? JSON.stringify(error.response.data).length : 'N/A'
                });
                throw new Error(`Itinerary API failed: ${error.message}`);
            }

            // Conclusion
            try {
                console.log('Calling Conclusion API:', endpoints.conclusion);
                responses.conclusion = await axios.post(endpoints.conclusion, 
                    { language, city, startDate, endDate });
                if (responses.conclusion.data.response.includes('```')) {
                    responses.conclusion.data.response = responses.conclusion.data.response
                        .replace(/```html\n|```/g, '')
                        .replace(/\n\s+\+\s+/g, '');
                }
                validateResponse(responses.conclusion, 'conclusion');
            } catch (error) {
                console.error('Conclusion API error:', error.response?.data || error.message);
                throw new Error(`Conclusion API failed: ${error.message}`);
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
            ].join('\n').replace(/```html\n|```/g, '');  // Clean directly when joining

            console.log('Final content length:', generatedContent.length);
            console.log('Content preview:', generatedContent.substring(0, 200) + '...');

            try {
                // Test if we can stringify the content
                JSON.stringify({ generatedContent });
                console.log('JSON stringify successful');
                
                // If it succeeds, send the response
                res.json({ generatedContent });
            } catch (err) {
                console.error('JSON stringify failed:', err.message);
                console.error('GeneratedContent type:', typeof generatedContent);
                console.error('GeneratedContent length:', generatedContent?.length);
                res.status(500).json({
                    error: 'Failed to stringify response',
                    details: err.message
                });
            }

            // JSON.stringify( { generatedContent } ); // This will throw if invalid
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