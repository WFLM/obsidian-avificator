# Contributing

Bug reports, ideas, and pull requests are welcome.

## Reporting a bug

Open an [issue](https://github.com/WFLM/obsidian-avificator/issues) and
include:

- Your operating system and Obsidian version.
- The output of `magick -version`.
- The image format, and whether you pasted or dropped the image.
- What you expected and what happened instead.
- Any errors in the developer console (Ctrl+Shift+I, or Cmd+Option+I on
  macOS).

Please don't attach private images. If the bug depends on the image, a
sample that shows it is enough.

## Development

Node.js and npm are required. Clone the repository into the
`.obsidian/plugins/avificator` folder of a test vault, not your main one:
the plugin deletes the original images it replaces.

```bash
npm install
npm run build   # type check, then bundle main.js
npm test        # unit tests
```

Reload Obsidian, or turn the plugin off and on, to load a new build.

## Pull requests

- Keep each pull request to one change.
- Add or update tests when behavior changes.
- Make sure `npm run build` and `npm test` pass.
- Follow the [Obsidian plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).
  The community directory checks plugins with
  [eslint-plugin-obsidianmd](https://github.com/obsidianmd/eslint-plugin).

Contributions are released under the [MIT License](LICENSE).
