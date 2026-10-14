---
name: Spacewalk
description: A live heat map of what fills this Mac's disk, colored by how much of it can safely go.
colors:
  ground: "#0e0f11"
  pop: "#16181b"
  graphite: "#2a2e33"
  line: "#4a5058"
  disabled: "#6b717a"
  muted: "#9aa0a8"
  subhead: "#bcc1c7"
  ink: "#f2f2f2"
  oxide: "#8e2b22"
  tile-red: "#c8392b"
  signal: "#e5402f"
  red-text: "#ef5b4b"
typography:
  tile-label:
    fontFamily: "'Archivo Variable', 'Archivo', ui-sans-serif, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "normal"
  tile-heading:
    fontFamily: "'Archivo Variable', 'Archivo', ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 650
    letterSpacing: "0.07em"
  figure:
    fontFamily: "'Archivo Variable', 'Archivo', ui-sans-serif, system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 650
    lineHeight: 1
    letterSpacing: "-0.01em"
    fontFeature: "'tnum'"
  headline:
    fontFamily: "'Archivo Variable', 'Archivo', ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 750
    lineHeight: 1.2
  title:
    fontFamily: "'Archivo Variable', 'Archivo', ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.25
  body:
    fontFamily: "'Archivo Variable', 'Archivo', ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
  row:
    fontFamily: "'Archivo Variable', 'Archivo', ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  caption:
    fontFamily: "'Archivo Variable', 'Archivo', ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  label-caps:
    fontFamily: "'Archivo Variable', 'Archivo', ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 650
    letterSpacing: "0.07em"
rounded:
  page: "0px"
  hairline: "1px"
  inner: "2px"
  element: "3px"
  container: "4px"
spacing:
  tile-gutter: "1px"
  tight: "4px"
  actions: "6px"
  column-inset: "16px"
  bar-gap: "20px"
  legend: "34px"
  crumbs: "40px"
  top: "48px"
  side: "360px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    rounded: "{rounded.element}"
  button-secondary:
    backgroundColor: "rgba(242, 242, 242, 0.12)"
    textColor: "{colors.ink}"
    rounded: "{rounded.element}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.element}"
  peek-card:
    backgroundColor: "{colors.pop}"
    textColor: "{colors.ink}"
    rounded: "{rounded.container}"
    padding: "10px 12px 11px"
  inspector:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    padding: "14px 16px 12px"
  list-row:
    textColor: "{colors.ink}"
    typography: "{typography.row}"
    padding: "7px 16px 9px 0"
  category-head:
    textColor: "{colors.ink}"
    typography: "{typography.row}"
    padding: "9px 16px 9px 8px"
  mark-button:
    textColor: "{colors.disabled}"
    rounded: "{rounded.element}"
    size: "22px"
  mark-button-on:
    textColor: "{colors.ink}"
  heat-bar:
    backgroundColor: "{colors.graphite}"
    rounded: "{rounded.hairline}"
    height: "6px"
---

# Design System: Spacewalk

## Overview

**Creative North Star: "The Market Map"**

Spacewalk draws the disk the way a market heat map draws a stock index. Tile area is size. Color runs from graphite to red by how safely the bytes can go. Sector headers in spaced capitals name each folder group, bold white labels sit centered in each tile and shrink to fit it, and one-pixel gutters of the near-black ground separate everything. The map fills the screen left of a 360px column; there are no cards, no gradients on surfaces, and no decoration that does not carry a number or a name.

The page is always dark. The chrome around the map is graphite and white, so the only warm color on screen is the map's own heat and the figures that report it. Density is high on the map and calm in the column: the column uses one 16px inset, hairline rules, and tabular figures, and lets the lists scroll under a fixed details panel.

The map moves like a camera. Diving into a tile grows it to fill the frame while its neighbours slide out past the edges, and its contents come up inside it as it grows. Values elsewhere settle in place on rolling digit reels. The frame itself never moves.

**Key Characteristics:**
- Near-black ground, graphite tiles, a three-stop OKLab heat ramp to red.
- Red appears only where bytes can go.
- Square tiles on 1px ground gutters; small radii on controls only.
- Archivo variable throughout, condensed on the map when a name needs room, tabular figures for every size.
- Flat surfaces; shadow only on layers that float over the map.
- Exponential ease-out for every move, with a reduced-motion path that fades in place.

## Colors

A graphite and white instrument with one warm axis: the heat ramp from graphite through oxide to red.

### Primary
- **Tile Red** (tile-red): the "safe to delete" end of the heat ramp and the fill for fully reclaimable tiles. It stops at a red deep enough to carry white labels at 4.6:1 (`ui/src/lib/heat.ts`). Also the safe-to-delete segment of every heat bar and swatch.
- **Oxide** (oxide): the middle stop of the ramp, "worth a look". Tiles that are half check-first land here; the worth-a-look segment of heat bars and the check-first category bars use it.
- **Signal Red** (signal): large red figures on the ground, such as the 22px "Safe to delete" total in the Can go list, and the hot tile in the logo mark. Never a tile fill.
- **Red Text** (red-text): small red text on the ground and in cards: reclaimable sizes in rows, category sizes, the safe-to-delete figure in the breadcrumb row and inspector, the "Safe to delete" legend label.

### Neutral
- **Ground** (ground): the page, the map's gutters, the hatch backing, and the dark edge drawn behind words that sit on hatching.
- **Pop** (pop): the one raised surface: the hover card over the map, Astryx cards, popovers and menus.
- **Graphite** (graphite): "keep" tiles, system volumes (Swap, macOS, Preboot, Recovery), every hairline rule and border in the chrome, the empty track of heat bars, scrollbar thumbs.
- **Line** (line): outlines and hatching on the map: the free-space outline, the diagonal hatch on hidden and unscanned space, emphasized borders, the plain bar under marked rows.
- **Disabled** (disabled): mark buttons at rest and items inside a marked folder.
- **Muted** (muted): secondary text: counts, shares, hints, legend labels, the size on a tile heading, the label on the Free tile.
- **Subhead** (subhead): quieter primary text: kind lines, list headings, figure captions, sizes in non-reclaimable rows, headings at nesting depth 2 and below.
- **Ink** (ink): all primary text, tile labels, focus rings, selection and hover rings on the map, the primary button fill, the scan progress line.

The heat ramp is computed, not stored: 256 steps interpolated through OKLab between graphite, oxide and tile-red, so lightness climbs evenly and the order reads without color vision. A tile's heat is `(safe + 0.5 × worth a look) / size`. The legend draws the same ramp as `linear-gradient(in oklab 90deg, …)`.

### Named Rules
**The Red Means Reclaimable Rule.** Red marks bytes that can go and nothing else. Errors speak in white with an icon: the Astryx theme maps `--color-error` to ink, and toasts for problems carry the error icon.

**The Three Reds Rule.** Tile red fills tiles, signal red is for large figures on the ground, red text is for small type. Do not swap them: tile red is too dark for small text, signal red is too bright to carry white labels.

## Typography

**Display Font:** Archivo Variable (with Archivo, ui-sans-serif, system-ui, sans-serif)
**Body Font:** Archivo Variable, the same family
**Label/Mono Font:** ui-monospace, "SF Mono", Menlo (Astryx code token only; the app sets no mono text of its own)

**Character:** One grotesque at many weights and widths. Heavy weights (650 to 750) carry names and figures; the width axis is pulled in on the map to fit long names and pushed out to 112% for the wordmark.

### Hierarchy
- **Tile label** (700, 10px to 30px, line-height 1.08): a tile's name, centered, with its size under it at weight 500 and 0.66 of the name size (10px to 20px). The start size is `sqrt(w × h) / 7`, clamped to 10 to 30px, then fitted (`ui/src/treemap/layout.ts`).
- **Tile heading** (650, 11px at depth 1, 10px deeper, 0.07em tracking, uppercase): a folder group's name in capitals, with the size right-aligned in muted at weight 500. Ink at depth 1, subhead below.
- **Figure** (650, 32px, line-height 1, -0.01em, tabular): the inspector's size. The unit beside it is 15px/600 subhead.
- **Stage title** (750, 24px, line-height 1.15): the empty-map and server-down cards only.
- **Headline** (750, 20px, line-height 1.2, balanced, two lines max): the inspector's name.
- **Title** (700, 15px, line-height 1.25): the hover card's name. The wordmark is 15px/750 at 112% width.
- **Body** (400, 14px, line-height 1.4): the page default.
- **Row** (600, 13px): list item names, category labels, crumb figures, row sizes.
- **Caption** (400, 12px): counts, paths, shares, facts, hints.
- **Label caps** (650, 11px, 0.07em, uppercase): the inspector's kind line and list section headings. A list heading that repeats a search query keeps its case at 13px/600.

### Named Rules
**The Tabular Figures Rule.** Every size, count and share is set with tabular numerals (the `.num` class), so changing numbers keep their width.

**The Fitted Label Rule.** A tile label is set as large as the tile allows, from 30px down to 10px. A long name first tries the condensed width, then two or three lines broken after a dash, underscore or space, before a dot that is not inside a number, or where one lowercase word ends and a capitalised one begins. A lone capital (iPhone, clean.uPwt7o) is not a break. Plain beats condensed and one line beats more unless the other is clearly larger. Past that the name is cut with an ellipsis at 10px, or left off. Nothing on the map is set below 10px except labels caught mid-move.

## Layout

One screen, one grid (`ui/src/styles/app.css`, `.app`): a 48px top bar across the full width; under it a 40px breadcrumb row, the map, and a 34px legend strip on the left; a 360px column on the right running from the breadcrumb row to the bottom. The page does not scroll on desktop.

- **Top bar:** brand at left, the search field centered (max 440px), scan status and Rescan at right, 20px gaps. A 2px ink line along its bottom edge shows scan progress.
- **Breadcrumb row:** an up button, the path, and the focus total with its safe-to-delete figure at right. A 1px ink sweep along its bottom shows a dive that is waiting for data.
- **Map:** fills its cell edge to edge. The layout is squarified and nests up to three levels while a group is at least 64px wide, has room for its heading plus 30px, and covers 5,600px². Heading rows are 20px at depth 1, 16px at depth 2, 14px at depth 3; inner padding is 2px, then 1px. A folder holding only one folder shares its heading row ("USERS / NICKY").
- **Column:** the details panel on top, then the tab bar and lists. The details panel keeps a 336px minimum height, capped at 55% of the column, so the tab bar stays put as the selection moves; content that needs more room (a two-line name) pushes it down rather than hiding its buttons. The lists scroll under it.
- **Rhythm:** a 16px horizontal inset in the column; 4px, 6px, 8px, 10px, 12px and 14px for gaps inside it; 6px between buttons in a row.

**Small screens (max-width 760px):** one column. The top bar becomes sticky and wraps the search field onto its own line; the machine name, free space, scan time and the `/` hint hide. The map takes `min(66svh, 600px)`, the legend wraps, and the details panel and lists follow at full height with the page scrolling. The details panel drops its minimum height. Mark buttons grow to 28px.

**Touch (hover: none):** mark buttons show at rest. The hover card docks along the bottom of the map, inset 8px, and takes taps.

### Named Rules
**The Fixed Frame Rule.** The frame never moves. Values change in place, the details panel holds its height, and loading shows as a line along an existing edge, never as a shift in layout.

## Elevation & Depth

Flat by default. The map, bars and column are drawn on one plane and separated by 1px ground gutters and 1px graphite rules. Depth on the map comes from nesting (heading rows and inner padding) and from rings, not shadows. Only layers that float over the map take a shadow.

### Shadow Vocabulary
- **High** (`box-shadow: 0 4px 8px rgba(0, 0, 0, 0.45), 0 16px 40px rgba(0, 0, 0, 0.5)`): the hover card over the map, and Astryx menus and popovers through `--shadow-high`.
- **Medium** (`box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4), 0 8px 20px rgba(0, 0, 0, 0.35)`) and **Low** (`box-shadow: 0 1px 2px rgba(0, 0, 0, 0.45)`): set in the Astryx theme for its own components; the app's CSS does not use them directly.
- **Selected inset** (`box-shadow: inset 0 0 0 2px #F2F2F2`): Astryx's selected state. The map draws its own focus the same way, as a 2px inset ink ring over the canvas.

### Named Rules
**The Flat Map Rule.** Nothing on the map or in the column casts a shadow. A shadow means the thing floats over the map and will go away.

## Shapes

Tiles are square-cornered rectangles separated by 1px gutters of ground, snapped to device pixels. Controls take small radii from the Astryx theme: 3px for buttons, mark buttons and inputs, 4px for cards and the hover card, 2px for inner parts, 0 for the page. Bars, swatches and the legend ramp use a 1px radius so their ends read as cut, not rounded.

Map states are drawn as lines and corners, not fills:
- **Free space:** a 1px line outline, no fill.
- **Hidden or unscanned space:** a 1px line diagonal hatch on a 7px repeat over ground. Unscanned space drifts sideways while the scan runs.
- **Many small items ("22 more"):** the heat fill with fine vertical rules of ground at 32% every 3px.
- **Marked:** a folded corner at the top right, 7px to 16px (20% of the tile's short side): a ground triangle with an ink triangle under it, the page turned down.
- **Hover:** a 2px ink ring on the tile and a 1px ink ring at 32% on its parent group.
- **Selected:** a 2px ink ring plus a 1px ink ring inset 4px.
- **Pressed:** a ground ring growing to 3px over 90ms with a 14% ground wash, released over 160ms.
- **Scanning here:** a 1.5px ink ring pulsing between 25% and 75% on the folder the scan is reading.

The icon set is drawn on a 20-unit grid with a 1.5 stroke, round caps and joins, to sit beside Astryx's own icons (`ui/src/components/icons.tsx`). The logo is three map tiles: two in line, one in signal red.

### Named Rules
**The Square Tile Rule.** Tiles never round their corners and never lose their 1px gutter. Rounding belongs to controls.

## Components

Astryx (`@astryxdesign/core` 0.1.9, StyleX 0.19.1) supplies buttons, icon buttons, the text input, tabs, breadcrumbs, the context menu, spinners, keyboard hints and toasts, all dressed by the `spacewalk` theme in `ui/src/theme.ts`. The map, the hover card, the details panel, rows, heat bars and the digit reels are the app's own.

### Buttons
- **Shape:** gently squared (3px radius), Astryx size `sm` everywhere.
- **Primary:** ink fill with ground text. Used once per surface: Open in the hover card, and Scan this Mac or Rescan when there is no map yet.
- **Secondary:** ink at 12% on the ground with ink text. Rescan, Open, Reveal in Finder, Copy all paths, Scan and ask for access.
- **Ghost:** transparent with ink text. Mark, Stop, Clear the gone ones, the up button and Copy path.
- **Hover / Focus:** Astryx overlays ink at 6% on hover and 11% pressed. Focus is a 2px ink outline offset 2px.
- **Icons:** Rescan, Stop, Mark and Marked, Copy path and Copy all paths carry a leading icon; Open carries a trailing chevron. Reveal in Finder and Clear the gone ones have none.

### Mark button
- **Style:** a 22px square (28px on small screens) in the left column of a row, 3px radius, holding the page-with-turned-corner icon at 16px.
- **State:** hidden until the row is hovered or focused; shown at rest when on, inside a marked folder, gone, or on touch. At rest disabled gray, ink when on, a check in muted when gone. Hover adds an ink wash at 8%.

### Hover card (Peek)
- **Style:** pop surface, 1px graphite border, 4px radius, the high shadow, 180px to 300px wide, padding 10px 12px 11px. Name at 15px/700, kind in subhead, size at 20px/650 with its share, a heat bar, the safe and worth-a-look figures with swatches, and a hint.
- **Motion:** follows the pointer. It comes in over 140ms and leaves in 70ms, so it is gone before a dive gets going. On touch it docks to the bottom of the map and rises 10px over 260ms.

### Details panel (Inspector)
- **Style:** on the ground, padding 14px 16px 12px, 1px graphite rule under it, 336px minimum height. Name, kind in label caps, a three-line blurb in muted, the size as a 32px figure on digit reels, a 6px heat bar, figures, a two-column facts grid with hairline rules, the path with Copy path, and the actions row.

### Lists (Can go, Largest, Marked)
- **Tabs:** Astryx tab list, small, filling the column width, with a divider. The Marked tab carries its live count in muted.
- **Section heading:** label caps in subhead with the section total right-aligned at 13px/650, red text when the section is safe to delete.
- **Category:** a full-width button with a chevron that turns 90° over 220ms, the label, the size (red text when safe to delete), a 4px bar in tile red or oxide, and a count. Hover washes ink at 4%; categories are split by 1px graphite rules.
- **Row:** a 30px mark column, then the name at 13px/600, the size in subhead (red text when more than half of it can go), the kind and parent path in caption, and a 3px heat bar scaled against the list's largest. Hovering a row lights its tile on the map.
- **Totals (Marked):** the marked total as a 22px/750 figure in ink with a caption under it.

### Heat bar
- **Style:** 6px tall (3px in rows), 1px radius, graphite track, with a tile-red segment for safe-to-delete bytes and an oxide segment for worth-a-look bytes. The plain variant in the Marked list uses a line-colored bar for size only.

### Inputs / Fields
- **Search:** Astryx text input, small, with a search icon, a clear button, a loading state, and a `/` key hint at the right when empty. The focus ring wraps the whole field (2px ink, offset 2px, 5px radius) instead of the input inside it.

### Navigation
- **Breadcrumbs:** Astryx breadcrumbs after a ghost up button. The address bar holds the place, so a folder can be bookmarked.
- **Context menu:** Astryx context menu on the map (reveal, copy path, mark).

### Digit reels (Settle)
Sizes in the details panel, the breadcrumb total and the live scan count roll to their new value: each digit is a vertical strip that moves over 420ms, starting with the last digit and delaying 18ms per place toward the first.

### The map (signature component)
A canvas treemap (`ui/src/treemap/`). Every move is a planned change between two layouts with tiles matched by key, so anything on screen before and after travels instead of popping.

- **Durations** (`DURATION` in `engine.ts`): intro 420ms, dive 520ms, up 440ms, jump 300ms, settle 360ms, fade 240ms.
- **Easing:** positions follow exponential ease-out, `1 - 2^(-10t)`; opacity changes use smoothstep. CSS motion uses `cubic-bezier(0.16, 1, 0.3, 1)`, the same curve.
- **Dive:** the opened tile grows to fill the frame, neighbours slide out past the edges solid, and its contents come up inside it. Old words leave before new ones arrive; words never overlap.
- **Up:** the same move backwards: the view shrinks into its folder's tile and neighbours slide back in.
- **Search:** tiles that hold a result stay lit; the rest dim to 24%.
- **Labels in motion** keep the font they were fitted at and scale with the tile, so a moving label never re-wraps.

### Reduced motion
With `prefers-reduced-motion: reduce`, nothing on the map travels: a change fades in place over 240ms and settles happen at once. The unscanned hatch stops drifting. In CSS, the reels, hover card, chevron and scan line lose their transitions, and the scan sweep becomes a still line at 40%.

## Do's and Don'ts

### Do:
- **Do** color by heat with the shared ramp: graphite for keep, oxide for worth a look, tile red for safe to delete, interpolated in OKLab.
- **Do** set every size, count and share in tabular numerals.
- **Do** use tile red for fills, signal red for large figures on the ground, and red text for small type.
- **Do** keep tiles square with 1px ground gutters, and draw map states as rings, outlines, hatching and folded corners.
- **Do** move the map with exponential ease-out at the durations in the engine's table (dive 520ms, up 440ms), and give every move a fade-in-place path for reduced motion.
- **Do** keep the frame still: hold the details panel at its 336px minimum and show loading as a line along an existing edge.
- **Do** keep a name and size reachable as text for every colored thing, on hover, in the details panel, or in a list.

### Don't:
- **Don't** use red for errors, warnings, focus or brand accents; problems speak in white with an icon.
- **Don't** put white labels on signal red or red text; only tile red and darker carry white labels.
- **Don't** give the map, the column or list rows a shadow; shadows are for layers that float over the map.
- **Don't** round tile corners or add gradients to surfaces; the legend ramp is the only gradient, and it is a key.
- **Don't** set map text below 10px at rest; cut it short or leave it off.
- **Don't** show item states as pill badges; states are marks in the row's fixed left column or corners on the tile.
