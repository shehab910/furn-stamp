**Handoff: Furniture stamp tool**

**What it is:** a static web app (currently `index.html`), run in desktop Chrome/Edge or on a phone. It stamps furniture shopping info onto photos and saves them into a local folder that the Google Drive for desktop app keeps in two-way sync with Google Drive: files added locally appear in Drive, and files deleted locally are deleted from Drive. The app itself never syncs anything; Drive for desktop does all of it, which is why the app stays simple. There is no backend.

**Two modes, picked automatically:**

- **Desktop Chrome/Edge (local mode):** uses the File System Access API on the local synced folder, as before. No Google sign-in.
- **Phones and any browser without `showDirectoryPicker` (Drive mode):** reaches the same folder in Google Drive through the Drive REST API, signing in with Google Identity Services (scope `drive`, token kept in localStorage for its 1-hour lifetime). `DriveFolder` and `LocalFolder` share one small interface, so the save, edit and gallery code is shared. Uploads are resumable; edits replace a file's content in place, keeping the file ID. Gallery tiles use Drive thumbnails instead of downloading full photos. The folder is chosen by searching its name or pasting its link. The phone layout puts the photo panel above the form. Edit mode starts from the gallery's pencil icon, and there's no Recent strip.
- Drive mode needs `GOOGLE_CLIENT_ID` filled in and the page served over HTTPS from an origin listed on that OAuth client.

**Files (plain scripts, no build step, so `index.html` still opens straight from disk):**

- `index.html`: markup and CSS.
- `stamp.js`: the watermark renderer. It's pure: `paint(bitmap, plan)`, where a plan says full stamp or overlay, which slots, rating and seen IRL.
- `store.js`: the piece store. It holds the naming pattern, the `.txt` sidecar format, `listPieces`/`loadPiece`, and two folder adapters (`LocalFolder`, `DriveFolder`) with one small interface: `list`, `sub`, `write`, `allowed`.
- `app.js`: the UI. Its "edit rules" section holds what's locked, what gets overlaid and the merged sidecar.

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

**Decisions made (don't revisit):** no originals are kept; edits are overlay-only. No videos. No FB/IG link fetching. Category is required and everything else is optional. Drive for desktop deletions sync to Drive, which the user is fine with.

**Known limits:** Drive mode needs a Google sign-in popup about once an hour of use (the OAuth app is in Testing mode, with no refresh tokens). Folders the phone creates through the API and folders created locally but not yet synced could end up as two folders with the same name. Typos in already-filled fields can't be fixed without re-saving. The rendering hasn't been visually tested here; only syntax was checked.

**User preferences:** direct, concise answers, no padding.
