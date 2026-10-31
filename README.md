# AVIFicator

Automatically converts newly added PNG, JPEG, WEBP, HEIC, GIF, BMP, TIFF, and
JPEG XL images in your notes to AVIF format using ImageMagick (`magick`
command), and renames them, as well as AVIF images, using a template.

## Features

- Converts images right after you add them to a note.
- Renames images using a template: the note title and a precise timestamp
  by default.
- Updates Obsidian wiki embeds and Markdown image links.
- Can remove EXIF data, such as GPS location, from converted images.
- Can shrink large images to a maximum size.
- Keeps the original image if conversion or link replacement fails.
- Never converts animated or multi-page images, so nothing is lost.
- Copies images that Obsidian would only paste as a `file:///` address when
  they are dragged from a file manager, as happens on Linux with Wayland.
- Switches between converting, only renaming, and doing nothing right from
  the status bar or the command palette.
- Lets you configure AVIF image quality from 0 to 100.

## Installation

The plugin requires Obsidian Desktop 1.6.6 or newer.

### 1. Install ImageMagick

ImageMagick 7 must be installed with the `magick` command available in `PATH`,
or with its full path set in the plugin settings. Its build must support
writing AVIF files and reading every input format you want to convert.

Check AVIF and HEIC support:

```bash
magick identify -list format | grep -Ei "AVIF|HEIC"
```

The `AVIF` entry must include write support. The `HEIC` entry must include read
support if you want to convert HEIC files. The plugin settings show the same
information under **ImageMagick path**.

If your ImageMagick build lacks AVIF or HEIC support on Debian or Ubuntu,
[IMEI — ImageMagick Easy Install](https://github.com/SoftCreatR/imei) builds
ImageMagick for supported releases with the required AVIF and HEIC delegate
libraries.

### 2. Install the plugin

In Obsidian, open **Settings → Community plugins → Browse**, search for
**AVIFicator**, then install and enable it.

To install it manually, download `main.js`, `manifest.json`, and `styles.css`
from the
[latest release](https://github.com/WFLM/obsidian-avificator/releases/latest)
into `.obsidian/plugins/avificator/` in your vault. Then enable **AVIFicator**
under **Settings → Community plugins**.

### Building from source

Node.js and npm are required:

```bash
git clone https://github.com/WFLM/obsidian-avificator.git .obsidian/plugins/avificator
cd .obsidian/plugins/avificator
npm install
npm run build
```

The build creates `main.js` in the plugin folder.

## Usage

- Drop or paste an image into an open Markdown note. All formats listed under
  [Input formats](#input-formats) are converted and renamed by default; you
  can choose which formats are renamed, converted, or both.
- The plugin will:
  - Convert it to `.avif` using the configured quality.
  - Remove its EXIF and XMP metadata, if you turn this on.
  - Shrink it to the maximum size, if you turn this on.
  - Rename it using the [file name template](#file-name-template), or keep
    its name if renaming is off for the format.
  - Replace the original image link with the new AVIF link.
  - Move the original to trash only after the link is updated successfully,
    following Obsidian's **Deleted files** setting.
  - Preserve the original and notify you if conversion fails.

### Modes

The current mode is shown in the status bar as `AVIF: convert`,
`AVIF: rename`, or `AVIF: off`. Click it to switch modes. You can also switch
modes with the **Switch mode to …** commands in the command palette and assign
them hotkeys. The mode is saved and stays the same after restarting Obsidian.

- **Convert to AVIF** (default): converts and renames images as checked under
  [Input formats](#input-formats).
- **Rename only**: renames images of the formats with **Rename** checked and
  updates the link, without converting them. Metadata and size are kept.
- **Off**: leaves new images untouched.

### Animated and multi-page images

An AVIF file made from an animated GIF, WEBP, PNG, or JPEG XL image, or from a
multi-page TIFF, would show only the first frame or page. So in **Convert to
AVIF** mode the plugin checks every image first and never converts these. If
**Rename** is unchecked for the format, such an image is left as is. Otherwise,
by default, the plugin asks what to do:

- **Rename only**: renames the image and updates the link, keeping the
  animation or pages.
- **Leave as is**: doesn't touch the image or the link. Closing the window does
  the same.

In **Rename only** mode, and for formats with only **Rename** checked, these
images are renamed as usual.

Images ImageMagick can't open are handled the same way, without asking: they
are renamed if **Rename** is checked for the format, and left as is otherwise.

## Settings

The settings are grouped like this:

- At the top: **Mode**, **Show mode in status bar**, and **Copy dragged
  images (file:/// links)**.
- **File names**: **File name template** and **Replace spaces with
  underscores**, described in [File name template](#file-name-template).
- **Conversion**: options used only in **Convert to AVIF** mode.
- **Input formats**: which formats are renamed and converted, described in
  [Input formats](#input-formats).

**Mode:** the same mode switch as in the status bar.

**Show mode in status bar:** on by default. Turn it off to hide `AVIF: …` from
the status bar. Modes can still be switched here or with the commands.

**Copy dragged images (file:/// links):** on by default. Sometimes, for example
on Linux with Wayland, Obsidian gets only the `file:///` address of an image
dragged from a file manager and pastes it as text instead of copying the
image. With this option, the plugin copies such images into the vault itself,
using Obsidian's attachment folder, so they are converted or renamed. Works in
**Convert to AVIF** and **Rename only** modes. Holding `Ctrl` (`Option` on
macOS) while dropping still inserts a link to the original file.

### File name template

The template sets how images are named in both modes. The extension is added
automatically. Type `{` in the field to pick a variable from a list; an example
name below the field shows the result as you type. Variables:

| Variable | Value |
| --- | --- |
| `{title}` | the note title |
| `{original}` | the original file name, without the extension |
| `{date:FORMAT}` | the date and time in [Moment.js format](https://momentjs.com/docs/#/displaying/format/), the same as in daily notes. `{date}` is `{date:YYYY-MM-DD}` |
| `{counter}` | `000`, or `001`, `002`, and so on if the name is already taken |

The default template is `{title}-{date:YYYYMMDDHHmmssSSS}{counter}`. Examples
for the note "Team meeting" and the image `IMG_1234.jpg`:

| Template | File name |
| --- | --- |
| `{title}-{date:YYYYMMDDHHmmssSSS}{counter}` | `Team_meeting-20261031143005123000.avif` |
| `{date:YYYY-MM-DD} {title}` | `2026-10-31_Team_meeting.avif` |
| `{title}-{original}` | `Team_meeting-IMG_1234.avif` |

If the template has no `{counter}` and the name is taken, ` 1`, ` 2`, and so on
is added to the end. Characters that can't be used in file names or links,
such as `:` or `#`, are replaced with `-`; in the note title and the original
name, they are replaced like spaces.

**Replace spaces with underscores** (on by default) puts `_` in place of every
space in the name. Turn it off to keep spaces:
`2026-10-31 Team meeting.avif`.

### Conversion

These options apply only in **Convert to AVIF** mode, to formats with
**Convert** checked. Renamed images keep their metadata and size.

**Image quality:** enter a whole number from 0 (lowest) to 100 (highest).
The default value is 80.

**Remove metadata:** off by default. Removes EXIF and XMP data, including GPS
location and camera details. The image is rotated according to its EXIF
orientation first, so it stays upright, and its color profile is kept.

**Limit image size:** off by default. Shrinks images whose longer side exceeds
**Maximum size** (2000 pixels by default), keeping their proportions. Smaller
images are left as is.

**When you add an animated or multi-page image:** such images can't be
converted to AVIF, see [Animated and multi-page
images](#animated-and-multi-page-images). Choose **Ask every time** (default),
**Rename only**, or **Leave as is**.

**ImageMagick path:** the command name or full path of the `magick`
executable. The default is `magick`, looked up in `PATH`. Set the full path if
Obsidian can't find it, for example `/opt/homebrew/bin/magick` on macOS with
Homebrew: apps started outside a terminal don't see the shell's `PATH`.
Below the field, the plugin shows whether it found ImageMagick, its version,
whether it can write AVIF, and which of the plugin's input formats it can read,
whether they are turned on or not.
What works is shown in green, what doesn't in orange.

### Input formats

Each format has two checkboxes, both checked by default:

- **Rename** and **Convert**: the image is converted to AVIF and named using
  the template.
- **Rename** only: the image is renamed and keeps its format.
- **Convert** only: the image is converted to AVIF and keeps its name, for
  example `Pasted image 1.png` becomes `Pasted image 1.avif`.
- Neither: the plugin leaves images of this format alone.

AVIF images can only be renamed: converting AVIF to AVIF would only lose
quality, so AVIF has no **Convert** checkbox. AVIF files the plugin creates
itself are never renamed again.

In **Rename only** mode, the **Convert** column is ignored and dimmed; in
**Off** mode, both are. If ImageMagick can't read a format, its name is shown
in orange: such images can only be renamed.

| Format | Extensions |
| --- | --- |
| PNG | `.png` |
| JPEG | `.jpg`, `.jpeg`, `.jfif` |
| WEBP | `.webp` |
| HEIC | `.heic`, `.heif` |
| GIF | `.gif` |
| BMP | `.bmp` |
| TIFF | `.tif`, `.tiff` |
| JXL (JPEG XL) | `.jxl` |
| AVIF (rename only) | `.avif` |

## Troubleshooting

- Open the plugin settings and read the line under **ImageMagick path**: it
  says whether ImageMagick was found and what it supports.
- Make sure `magick` is available in your system `PATH`, or set its full path
  in the plugin settings.
- Make sure ImageMagick has AVIF write support.
- For HEIC files, make sure ImageMagick has HEIC read support.
- Make sure the image is inserted into the active Markdown note.
- If dragging an image from a file manager pastes a `file:///` address, make
  sure **Copy dragged images (file:/// links)** is on and the mode isn't
  **Off**.
- Check the Obsidian developer console (`Ctrl+Shift+I`) for detailed errors.
