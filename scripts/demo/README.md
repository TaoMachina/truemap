# The README GIF

`docs/images/demo.gif` is the real workspace and CLI on a pinned [Umami](https://github.com/umami-software/umami) checkout, recorded in headless Chrome or Edge at 1440×900 (2x). No agent runs and nothing is mocked. The script makes the CLI calls an agent would make: `reply`, `draft`, `plan`, `changes`. It also makes a real code edit.

Re-record after a UI change:

```sh
node scripts/demo/record.mjs          # frames into scripts/demo/.work/frames (first run fetches Umami)
python scripts/demo/compose.py        # writes docs/images/demo.gif
```

Needs Node 20+, git, Python with Pillow, and Chrome or Edge (`CHROME_PATH` to point at another one).

| File | What it is |
|---|---|
| `record.mjs` | Drives the workspace over the DevTools protocol and saves one PNG per beat, with click points |
| `compose.py` | Camera moves, cursor, captions, end card; one palette for all frames |
| `umami-map.html` | The map committed into the Umami checkout |
| `draft.html` | The draft page the "agent" writes when asked how a page view is recorded |

Everything the scripts create stays in `scripts/demo/.work/`, which git ignores. The npm package doesn't include this folder.
