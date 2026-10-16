#!/bin/bash

# Compress images larger than 4MB in the mount-kinabalu folder
# Uses sips (macOS built-in) to maintain quality while reducing file size

KINABALU_DIR="/Users/terrancehah/Documents/terrancehah.com/resources/articles/mount-kinabalu"
BACKUP_DIR="/Users/terrancehah/Documents/terrancehah.com/resources/articles/mount-kinabalu/originals"

# Create backup directory
mkdir -p "$BACKUP_DIR"

echo "🔍 Finding images larger than 3MB..."
echo ""

# Find images larger than 3MB
find "$KINABALU_DIR" -maxdepth 1 \( -name "*.JPG" -o -name "*.jpg" -o -name "*.jpeg" \) -size +3M | while read -r file; do
    filename=$(basename "$file")
    filesize=$(du -h "$file" | cut -f1)
    
    echo "📸 Processing: $filename ($filesize)"
    
    # Backup original
    cp "$file" "$BACKUP_DIR/$filename"
    echo "   ✓ Backed up to originals/"
    
    # Compress using sips
    # Quality 85 is a good balance between size and quality
    # Max dimension 2400px is enough for web display
    sips -s format jpeg \
         -s formatOptions 85 \
         --resampleHeightWidthMax 2400 \
         "$file" --out "$file" > /dev/null 2>&1
    
    newsize=$(du -h "$file" | cut -f1)
    echo "   ✓ Compressed: $filesize → $newsize"
    echo ""
done

echo "✅ Compression complete!"
echo "📁 Original files backed up to: $BACKUP_DIR"
