# Obsidian AVIF Image Converter
Automatically converts newly added PNG, JPEG, and WEBP images in your notes to AVIF format using ImageMagick (magick command).

### Features:
- Converts images right after you add them to a note.
- Output file is renamed to include the note’s title and a precise timestamp.
- Automatically updates the link in your note to point to the new AVIF file.
- Lets you configure AVIF image quality (0–100) in plugin settings.

### Installation

#### 1. Clone or download the plugin source to your Obsidian plugins folder:
```bash
.obsidian/plugins/obsidian-avificator/
```

#### 2. Build the plugin (if needed):
```bash
npm install
npm run build
```
#### 3. ImageMagick Requirements
To convert images to AVIF, your system must have ImageMagick (magick command) installed with AVIF support enabled.
Check support:
```bash
magick -list format | grep -i avif
```
You should see:
```txt
AVIF* rw+   AV1 Image File Format (AVIF)
```
If it isn't listed, your ImageMagick build lacks AVIF support. On Debian or Ubuntu, [IMEI](https://github.com/SoftCreatR/imei) can build ImageMagick with it.


#### 4. Enable the plugin in Obsidian settings → Community plugins.

### Usage
- Drop an image (.png, .jpg, .jpeg, .webp) into an open note.
- The plugin will:
  - Convert it to .avif using your configured quality.
  - Rename it as {note-title}-{timestamp}.avif.
  - Replace the original image link in the note with the new one.
  - Notify you upon success (or failure).

### Settings
Image Quality: Enter a number from 0 (lowest) to 100 (best). Default is 80.

### Troubleshooting
- Make sure magick is in your system PATH.
- Make sure your ImageMagick (magick) is compiled with AVIF support.
- Check developer console (Ctrl+Shift+I) in Obsidian for errors.
