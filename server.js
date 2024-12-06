const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(__dirname, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js')) {
            res.set('Content-Type', 'application/javascript');
        }
        if (filePath.endsWith('.mjs') || filePath.endsWith('module.js')) {
            res.set('Content-Type', 'application/javascript; charset=utf-8');
        }
    }
}));

const PORT = 5500;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});