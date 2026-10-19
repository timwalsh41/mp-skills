#!/bin/zsh

# Ensure both source and target arguments are provided
if [ "$#" -ne 2 ]; then
	echo "Usage: $0 <source_directory> <target_directory>; use full paths (not relative)"
    exit 1
fi

# Assign arguments to descriptive variables
SOURCE_DIR="$1"
TARGET_DIR="$2"

# Verify that the source directory actually exists
if [ ! -d "$SOURCE_DIR" ]; then
    echo "Error: Source directory '$SOURCE_DIR' does not exist."
    exit 1
fi

# Verify that the target directory actually exists
if [ ! -d "$TARGET_DIR" ]; then
    echo "Error: Target directory '$TARGET_DIR' does not exist."
    exit 1
fi

echo "Linking from $SOURCE_DIR to $TARGET_DIR..."

# Loop through directories only using a trailing slash
for dir in "$SOURCE_DIR"/*/; do
    # Handle edge case where no directories match the pattern
    [ -d "$dir" ] || continue
    
    # Strip the trailing slash from the path
    dir="${dir%/}"
    
    # Extract just the folder name to check for existing links
    folder_name=$(basename "$dir")
    
    # Optional: Skip if the link or folder already exists in target
    if [ -e "$TARGET_DIR/$folder_name" ] || [ -L "$TARGET_DIR/$folder_name" ]; then
        echo "Skipping: '$folder_name': already exists in target."
        continue
    fi
    
    # Create the symbolic link
    ln -s "$dir" "$TARGET_DIR/"
    echo "Linked: $folder_name"
done

echo "Done!"

