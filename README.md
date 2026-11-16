[![make.fun bounty](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/KIM7667/markdown-render-speed-2/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/KIM7667/markdown-render-speed-2/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

# markdown-render-speed-2

A dependency-free JavaScript markdown renderer whose `parse(markdown)`
returns exactly the HTML that marked 18.1.3 produces with default options
(CommonMark + GFM: tables, task lists, strikethrough, extended autolinks),
written from scratch for the make.fun bounty
[markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02).

## Layout

- `parse.js` — the renderer: an ES module exporting `parse(markdown)`.
  Block parsing (headings, lists, blockquotes, tables, fenced and indented
  code, HTML blocks, link reference definitions) feeds a spec-style inline
  parser (delimiter-run emphasis, code spans, links and images, autolinks,
  entity handling) that reproduces marked's output byte for byte.
- `main.ts` — the harness driver: reads `/input/cases.json`, renders each
  case with `parse`, writes `/output/html.json`.

## License

MIT — see [LICENSE](LICENSE).
