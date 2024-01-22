require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

app.use(cors(`*`));
app.use(bodyParser.json());

module.exports = async (req, res) => {
    if (req.method === 'POST') {
        const { generatedContent } = req.body;
        // const pdfShiftApiKey = process.env.PDFSHIFT_API_KEY;

        try {
            const response = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${Buffer.from(`api:${process.env.PDFSHIFT_API_KEY}`).toString('base64')}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    source: `<html><body>${generatedContent}</body></html>`,
                    // timeout: 60000,
                    // Add any additional options you need here
                    // header: {
                    //     source: `<header><img src='https://terrancehah.com/resources/TH-logo.png' id="logo" alt='Logo'><span>Travel-Rizz</span></header>`,
                    //     // Styling for the header
                    // },
                    // footer: {
                    //     source: '<footer>{% page %}t</footer>',
                    //     // Styling for the footer
                    // },
                    // css: 'https://terrancehah.com/generatedContent.css'
                    css: 'https://raw.githubusercontent.com/terrancehah/terrancehah.github.io/main/generatedContent.css',
                    sandbox: true
                })
            });

            if (!response.ok) throw new Error(`Error from PDFShift: ${response.statusText}`);

            const pdfBuffer = await response.arrayBuffer();
            res.setHeader('Content-Type', 'application/pdf');
            res.status(200).send(Buffer.from(pdfBuffer));
        } catch (error) {
            console.error("Error:", error);
            res.status(500).send("Internal Server Error");
        }
    } else {
        res.status(405).send('Method Not Allowed');
    }
};
