# Canonical mascot assets

The seven PNGs in `docs/mascot/` are byte-for-byte copies of the approved assets from the canonical Claude Bot source:

- Source repository: `iamGodofall/Claude-Bot`
- Source path: `public/mascot/`
- Source commit: `bc11b6fd5ea120949a86164b4440ab11224f3043`

## Integrity

Each destination Git blob ID matches the corresponding source Git blob ID. No image was redrawn, recoloured, cropped, or recompressed.

| Asset | Source and destination Git blob |
| --- | --- |
| `full-body.png` | `062fbace22fd2720dccd814e4d606270d688fe29` |
| `happy.png` | `b2f07239dea47a5a8f0adb9a3d1c139d4be710f7` |
| `focused.png` | `8ee2e32a175918401349207c9ad2c6abac584deb` |
| `thinking.png` | `91f85e6308fa5b65bb4158725feca359e1bb0d78` |
| `excited.png` | `bea80c7080e99beaea84394f236b341c5a7f808a` |
| `surprised.png` | `78ac9e98795c47898805890d5f05a6de685ff4fb` |
| `winking.png` | `f55d5d7e682a4db8653d23b976f6776e5734165e` |

## Expression rules

- `full-body.png`: primary brand and product introduction.
- `focused.png`: active work, review, and evidence inspection.
- `thinking.png`: genuine processing states.
- `happy.png`: verified success.
- `excited.png`: meaningful positive milestones.
- `surprised.png`: unexpected events, paired with an explicit status explanation.
- `winking.png`: informal, low-stakes moments only.

The expression must never overrule the evidence or the actual product status. A failed or tampered receipt must remain visually and textually unambiguous.

## Change control

Keep the source PNGs unchanged. Any future update must be copied from the canonical source at a recorded commit, with matching Git blob IDs. Product-specific sizes and layout treatments belong in CSS, not in modified master images.
