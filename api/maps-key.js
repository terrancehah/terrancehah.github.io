export default function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Ensure the API key exists
        if (!process.env.GOOGLE_MAPS_API_KEY) {
            throw new Error('Google Maps API key not configured');
        }

        // Return the API key
        return res.status(200).json({ 
            key: process.env.GOOGLE_MAPS_API_KEY 
        });
    } catch (error) {
        return res.status(500).json({ 
            error: 'Failed to retrieve API key',
            message: error.message 
        });
    }
}