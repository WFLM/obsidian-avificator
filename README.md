# Obsidian AVIF Image Converter

Automatically converts newly added PNG, JPEG, WEBP, and HEIC images in your
notes to AVIF format using ImageMagick (`magick` command).

## Features

- Converts images right after you add them to a note.
- Renames the output file using the note title and a precise timestamp.
- Updates Obsidian wiki embeds and Markdown image links.
- Keeps the original image if conversion or link replacement fails.
- Lets you configure AVIF image quality from 0 to 100.

## Installation

The plugin requires Obsidian Desktop 1.1.0 or newer. Node.js and npm are
required to build it from source.

### 1. Clone or download the plugin

Place the repository in your Obsidian plugins folder:

```text
.obsidian/plugins/obsidian-avificator/
```

### 2. Build the plugin

```bash
npm install
npm run build
```

The build creates `main.js` in the plugin folder.

### 3. Install ImageMagick

ImageMagick 7 must be installed with the `magick` command available in `PATH`.
Its build must support writing AVIF files and reading every input format you
want to convert.

Check AVIF and HEIC support:

```bash
magick identify -list format | grep -Ei "AVIF|HEIC"
```

The `AVIF` entry must include write support. The `HEIC` entry must include read
support if you want to convert HEIC files.

If your ImageMagick build lacks AVIF or HEIC support on Debian or Ubuntu,
[IMEI — ImageMagick Easy Install](https://github.com/SoftCreatR/imei) builds
ImageMagick for supported releases with the required AVIF and HEIC delegate
libraries.

### 4. Enable the plugin

Open Obsidian settings, go to **Community plugins**, and enable
**Obsidian AVIFicator**.

## Usage

- Drop or paste an image (`.png`, `.jpg`, `.jpeg`, `.webp`, or `.heic`) into an
  open Markdown note.
- The plugin will:
  - Convert it to `.avif` using the configured quality.
  - Rename it as `{note-title}-{timestamp}.avif`.
  - Replace the original image link with the new AVIF link.
  - Delete the original only after the link is updated successfully.
  - Preserve the original and notify you if conversion fails.

## Settings

**Image Quality:** enter a whole number from 0 (lowest) to 100 (highest).
The default value is 80.

## Troubleshooting

- Make sure `magick` is available in your system `PATH`.
- Make sure ImageMagick has AVIF write support.
- For HEIC files, make sure ImageMagick has HEIC read support.
- Make sure the image is inserted into the active Markdown note.
- Check the Obsidian developer console (`Ctrl+Shift+I`) for detailed errors.
