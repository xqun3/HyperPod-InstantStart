#!/bin/bash

# sudo apt-get update && sudo apt-get install -y ffmpeg
# MP4 to High Quality GIF Converter
# Usage: ./convert_to_gif.sh [input.mp4] [output.gif] [width] [fps]
# Or: ./convert_to_gif.sh (batch convert all mp4 files in current directory)

convert_single() {
    local input="$1"
    local output="$2"
    local width="${3:-1000}"
    local fps="${4:-15}"
    
    echo "Converting $input to $output..."
    echo "Settings: ${width}px width, ${fps}fps"
    
    # Generate palette
    ffmpeg -i "$input" -vf "fps=$fps,scale=$width:-1:flags=lanczos,palettegen" "${input%.*}_palette.png" -y
    
    # Convert with palette
    ffmpeg -i "$input" -i "${input%.*}_palette.png" -filter_complex "fps=$fps,scale=$width:-1:flags=lanczos[x];[x][1:v]paletteuse" "$output" -y
    
    # Clean up palette
    rm "${input%.*}_palette.png"
    
    echo "✓ Converted: $output"
}

# Check if specific file provided
if [ $# -ge 1 ]; then
    input="$1"
    output="${2:-${input%.*}.gif}"
    width="$3"
    fps="$4"
    
    if [ ! -f "$input" ]; then
        echo "Error: File $input not found"
        exit 1
    fi
    
    convert_single "$input" "$output" "$width" "$fps"
else
    # Batch convert all mp4 files
    echo "Batch converting all MP4 files in current directory..."
    
    for file in *.mp4; do
        if [ -f "$file" ]; then
            convert_single "$file" "${file%.*}.gif"
        fi
    done
    
    echo "✓ Batch conversion complete"
fi
