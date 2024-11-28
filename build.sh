#!/bin/bash

# Ensure dist directory exists
mkdir -p dist

# Build Tailwind CSS with PostCSS
npx tailwindcss -i ./tailwind.css -o ./dist/output.css --minify

# Copy necessary files to public directory
mkdir -p public
cp -r dist public/
cp -r resources public/
cp *.html public/
cp *.js public/
cp *.css public/