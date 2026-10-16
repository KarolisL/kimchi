---
name: pptx
description: Read, create, and edit PowerPoint (.pptx) decks with no Python and no LibreOffice. Use when the task involves a .pptx file — reading slides and speaker notes, building a new deck from an outline or template, or changing an existing deck.
requires-resource: skills.pptx
disables-skills: pptx
---

# PowerPoint decks

Work on `.pptx` files through the bundled `pptx.mjs` script shipped inside the Kimchi installation. It runs with Kimchi's own runtime — no Python, no pip, no LibreOffice.

Locate the script next to this SKILL.md (`scripts/pptx.mjs`) and run it with Kimchi itself as the JavaScript runtime:

```bash
BUN_BE_BUN=1 kimchi scripts/pptx.mjs <command> ...
```

On Windows, kimchi's bash tool runs Git Bash, so the same command works there.

## Commands

- `pptx.mjs read DECK [START-END]` — Markdown of the deck (titles, bullets, tables, speaker notes), up to 20 slides per call. Output carries locators (`## Slide N`, `[shape "..."]`, `[table N]`) that the other commands accept.
- `pptx.mjs inspect DECK` — layouts, placeholders, and shape names per slide. Use before editing a template-based deck.
- `pptx.mjs create OUT --content FILE` — build a deck from deck Markdown. Use a company's own template with `--template DECK`.
- `pptx.mjs edit IN --out OUT --ops FILE` — apply JSON edits (see `--ops-format`), never writes in place.
- `pptx.mjs check DECK` — report likely defects (text overflow, missing alt text, off-slide shapes).

Always report the output path and slide count to the user.
