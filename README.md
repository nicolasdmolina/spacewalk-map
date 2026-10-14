# Spacewalk

A live map of what fills this Mac's disk. Every tile is a folder or file, sized by the space it takes and colored by how much of it can safely go. Hover or tap a tile to see what it is, click to dive in, and keep going until the cause is obvious.

Spacewalk is read-only. It never deletes, moves, renames, or writes your files, and it never serves file contents, only names, paths, sizes, counts, kinds, and dates.

## Start it

```sh
git clone https://github.com/nicolasdmolina/spacewalk-map.git
cd spacewalk-map
./bin/spacewalk
```

The first run builds the scanner and the web app, then opens http://127.0.0.1:4747/. When the last scan is more than 10 minutes old a fresh one starts, and the map grows while it runs (about 100 seconds cold on an M4 Mac). Ctrl-C stops it; nothing keeps running in the background.

| Option | What it does |
|---|---|
| `--tailnet` | Also listen on this Mac's Tailscale address, so other devices on the tailnet can open the map. |
| `--host NAME` | Another name this Mac answers to on the tailnet. |
| `--port N` | Listen on port N instead of 4747. |
| `--no-open` | Don't open the map in the browser. |
| `--scan` / `--no-scan` | Start a fresh scan right away, or show the last scan without starting one. |
| `--snapshot FILE` | Show this snapshot instead of the latest scan. |

## Open it from another device

Start it on the Mac with `spacewalk --tailnet`, then open http://YOUR-MAC-NAME:4747/ on any device on the tailnet. It listens on 127.0.0.1 and the Tailscale address only. Do not put it behind Tailscale Funnel or any other public route.

From another device you can browse, search, mark, and copy paths. Reveal in Finder, and a scan that lets macOS ask for access, only work from a browser on the Mac itself.

## Using the map

- Hover or tap a tile for its size, its share of the folder, and how much of it can go.
- Click to dive in. Backspace, Escape, the up arrow beside the breadcrumb, or the browser's Back button go up a level. The address bar holds the place, so a folder can be bookmarked.
- On the map, the arrow keys move between tiles, Enter dives, and M marks the selected item. `/` jumps to search.
- Right-click a tile to reveal it in Finder, copy its path, or mark it to delete later.

A tile's color comes from how much of it can go: graphite is keep, dark red is worth a look, bright red is safe to delete, and a folder holding some of each lands in between. A hatched tile is space the scan could not see, and the outlined tile is free space.

## The column

- **Can go**: what is safe to delete in the place you are looking at, grouped by kind (node_modules, caches, build output, installers), then the things worth checking first (AI models, virtual machines, archives).
- **Largest**: the biggest files here, and folders nobody has touched in 90 days.
- **Marked**: your delete list. Spacewalk never deletes anything; copy the paths or reveal them in Finder and delete them yourself. Items you have deleted show as gone after the next scan.

## What the numbers mean

- Sizes are on-disk (allocated) bytes.
- Data stored once but reachable from several places, through hard links or APFS clones, counts once and is split evenly among those places, so totals never exceed the disk. The inspector also shows how much deleting an item frees at least.
- **Hidden from scan** is the gap between what the volume reports as used and what the scan could read: APFS snapshots, purgeable space, and folders macOS keeps private.
- Swap, macOS, Preboot, and Recovery are the system volumes on the same disk.

## Private folders

macOS blocks some folders, such as `~/Library/Mail`, unless the app Spacewalk was started from has Full Disk Access. Scans carry on past them and count what they hold in the hidden gap. To include them, give that app (Terminal, iTerm, and so on) Full Disk Access in System Settings, under Privacy & Security, then rescan.

Other apps' data folders and Photos libraries make macOS show a permission prompt on the Mac's screen, and the read waits until someone answers. Scans never open those unless access is already granted, so nobody has to be at the Mac. To include them, select the hidden tile in a browser on the Mac itself and choose "Scan and ask for access".

The Shortcuts container (`~/Library/Group Containers/group.is.workflow.shortcuts`) is never opened, because listing it has hung a scan before. A folder that stalls a scan is left alone for seven days.

## Where things live

| Path | What it holds |
|---|---|
| `bin/spacewalk` | The launcher. Rebuilds the scanner or the web app when their source is newer. |
| `scanner/scan.c` | The native, parallel scanner, built to `scanner/spacewalk-scan`. |
| `server/` | The local server, with no dependencies. `kinds.mjs` decides what counts as safe to delete. |
| `ui/` | The web app (React 19, Astryx). The map is drawn on a canvas in `ui/src/treemap/`. |
| `DESIGN.md` | The design system: colors, type, motion, and the rules the interface follows. |
| `~/Library/Caches/Spacewalk/` | Scan snapshots. Safe to delete; the next start scans again. |
| `~/Library/Application Support/Spacewalk/jettison.json` | The marked list. |

## Requirements

macOS, Node.js 22 or newer (`brew install node`), and the Xcode Command Line Tools for `clang`. The launcher installs the web app's packages with `npm` the first time.
