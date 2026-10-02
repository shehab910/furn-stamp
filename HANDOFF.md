**Handoff: Furniture stamp tool**

**What it is:** a single self-contained HTML file (`furniture-stamp.html`), run locally in desktop Chrome/Edge. It stamps furniture shopping info onto photos and saves them into a local folder that Google Drive for desktop backs up to Google Photos. There is no backend and no Google API; the folder sync was chosen on purpose instead of the Photos API.

**Stack:** vanilla JS/HTML/CSS. Canvas does the image work, the File System Access API reads and writes folders, and IndexedDB stores the folder handles. localStorage holds categories and autofill history. The font is Bricolage Grotesque from Google Fonts. Light and dark themes come from CSS tokens.

**Form fields:** Category (the only required field; free text with suggestions Dining, Bedroom, Living, Tables, editable via an "Edit list" dialog), Item, Store, Price, Size, Rating (0–5 stars), Seen IRL (checkbox, stored as `Seen: yes|no`) and Description.

- Item, Store and Size autofill from history: past saves plus the `.txt` files in the save folder.
- Tab completes to the first matching suggestion.
- Picking a known item fills its other empty fields.

**Input:** drag-and-drop, Ctrl+V paste (works with Snipping Tool), a file picker, and a "Recent" strip showing the 5 newest images from a chosen source folder. The strip refreshes when the tab regains focus. Chrome blocks the root Downloads folder, so the user picks a subfolder.

**Watermark layout (version 4, stored as `Layout: 4` in the .txt):** fixed slots, all sized relative to `min(W,H)*0.04`.

- **Top band:** Description, 2 lines reserved, cut off with "…".
- **Bottom band, row 1:** Item in large text, then the Seen IRL badge, then 5 stars right-aligned on the same line. Stars are gold `#E8B931` when rated and black when not.
- **Bottom band, row 2:** Category | Store | Price | Size in fixed columns (20/32/22/26%) with dividers.
- **Seen IRL badge:** an opaque pill left of the stars (green "✓ Seen IRL" or dark "Not seen"), both states the same size. Version 4 narrowed the item slot to make room; version 3 pieces stay editable, keep `Layout: 3`, and get the badge drawn over the end of their item row.
- Bands are always drawn and empty slots stay blank. Text shrinks to 70% and is then cut with "…".
- The stamp is drawn after any downscaling, so the geometry can be recomputed exactly from the saved file's dimensions.

**Saving:** into one subfolder per category inside the chosen save folder (e.g. `Living/`), created on demand. The folder name is the category as typed, with characters Windows forbids stripped; no deeper nesting.

- Files are `category_YYYY-MM-DD_xxxx_NN.jpg`, where xxxx is a random 4-char batch ID, plus a sidecar `category_YYYY-MM-DD_xxxx.txt` with labeled lines (Layout, Category, Item, Store, Price, Size, Rating, Date, Description).
- New photos keep full resolution at JPEG 0.95, capped at 10 MB: quality steps down first, then resolution (6000, 4096, 3200).
- A fully successful save to the folder clears the batch and resets the form. A download clears the batch but keeps the form filled.
- Older pieces in `Category/piece/info.txt` subfolders are still read and can still be edited.

**Edit mode:** "Edit a saved piece" opens a file picker. The tool finds the sibling photos by prefix and loads the .txt.

- Filled fields are locked; empty ones can be filled. Only newly filled slots are drawn, as an overlay with no backdrop.
- The rating and Seen IRL are never locked and are always redrawn; the stars and badge are opaque, so they fully cover the old ones.
- Overlay saves re-encode at 0.95 with no size cap.
- New photos dropped in edit mode get the full stamp and continue the numbering.
- Pieces whose layout isn't 3 or 4 are refused.

**Gallery tab:** one tile per photo, grouped and ordered by piece.

- Filters: search over item and description, category, store, a price range (the number is parsed from text: commas, "k" suffix and Arabic digits are handled), rating (N and up, 5 only, unrated), seen IRL (yes/no) and sort (newest, price ascending or descending, rating).
- Clicking a photo opens a fullscreen viewer with arrows, keyboard and swipe.
- A pencil icon in each tile's footer opens that piece in edit mode with that photo selected.
- Thumbnails lazy-load via IntersectionObserver.

**Layout of the UI:** a sticky sidebar holds the form, a file name preview and the actions (Save to folder or Apply to piece, Download stamped, Clear photos, Edit a saved piece or Cancel edit). The main area holds the Recent strip, drop zone, preview canvas, thumbnails, and "Choose folder" at the bottom.

**Decisions made (don't revisit):** no originals are kept; edits are overlay-only. No videos. No FB/IG link fetching. Category is required and everything else is optional. Drive for desktop deletions sync to Photos, which the user is fine with.

**Known limits:** desktop Chrome/Edge only for the folder features (Download works anywhere). Typos in already-filled fields can't be fixed without re-saving. The rendering hasn't been visually tested here; only syntax was checked.

**User preferences:** direct, concise answers, no padding.
