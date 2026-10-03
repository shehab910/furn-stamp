**Handoff: Furniture stamp tool**

**What it is:** a static web app with no backend and no build step. It stamps furniture shopping info onto photos and saves them into a folder that the Google Drive for desktop app keeps in two-way sync with Google Drive: files added locally appear in Drive, and files deleted locally are deleted from Drive. The app never syncs anything itself.

**Two modes, picked automatically:**

- **Desktop Chrome/Edge (local mode):** reads and writes the local synced folder with the File System Access API. No Google sign-in. `index.html` opens straight from disk.
- **Phones and any browser without `showDirectoryPicker` (Drive mode):** reaches the same folder through the Drive REST API, signing in with Google Identity Services (scope `drive`; the 1-hour token is kept in localStorage).
  - Uploads are resumable. Edits replace a file's content in place, keeping the file ID.
  - Gallery tiles use Drive thumbnails.
  - The folder is chosen by searching its name or pasting its link.
  - The photo panel sits above the form. Edit mode starts from the gallery's pencil icon. There's no Recent strip.
  - Needs `GOOGLE_CLIENT_ID` (in `store.js`) filled in, and the page served over HTTPS from an origin listed on that OAuth client.

**Files:**

- `index.html`: markup and CSS.
- `stamp.js`: the watermark renderer. It's pure: `paint(bitmap, plan)`, where a plan says full stamp or overlay, which slots, rating and seen IRL.
- `store.js`: the piece store. It holds the naming pattern, the `.txt` sidecar format, `listPieces`/`loadPiece`, and two folder adapters (`LocalFolder`, `DriveFolder`) with one small interface: `list`, `sub`, `write`, `allowed`.
- `app.js`: the UI. Its "edit rules" section holds what's locked, what gets overlaid and the merged sidecar.

**Tests:** `npm test` runs Playwright (`tests/app.spec.js`) against the real app, in full Chromium (the headless shell crashes the page).

- Desktop mode uses the browser's private folder (OPFS) as the save folder, picked through a stubbed folder picker.
- Phone mode uses an in-memory fake of the Drive API (`tests/helpers.js`).
- Saved JPEGs are checked with pixel probes against `layout()` (text in each slot, gold star count, badge colour, no pixel changes outside edited areas) and with golden snapshots in `tests/app.spec.js-snapshots/` (Linux). After an intended visual change, run `npx playwright test --update-snapshots`.
- Quirk: in Chromium 1243, reading an OPFS handle back from IndexedDB crashes the page, so no test reloads with a folder set.

**Form fields:** Category (the only required field; free text with suggestions Dining, Bedroom, Living, Tables, editable via an "Edit list" dialog), Item, Store, Price, Size, Rating (0–5 stars), Seen IRL (checkbox, stored as `Seen: yes|no`) and Description.

- Item, Store and Size autofill from history: past saves plus the `.txt` files in the save folder.
- Tab completes to the first matching suggestion. Picking a known item fills its other empty fields.

**Input:** a file picker (camera or gallery on phones). On desktop also drag-and-drop, Ctrl+V paste (works with Snipping Tool), and a "Recent" strip showing the 5 newest images from a chosen source folder, which refreshes when the tab regains focus. Chrome blocks the root Downloads folder, so the user picks a subfolder.

**Watermark layout (version 4, stored as `Layout: 4` in the .txt):** fixed slots, all sized relative to `min(W,H)*0.04`.

- **Top band:** Description, 2 lines reserved, cut off with "…".
- **Bottom band, row 1:** Item in large text, then the Seen IRL badge, then 5 stars right-aligned. Stars are gold `#E8B931` when rated and black when not.
- **Bottom band, row 2:** Category | Store | Price | Size in fixed columns (20/32/22/26%) with dividers.
- **Seen IRL badge:** an opaque pill (green "✓ Seen IRL" or dark "Not seen"), both states the same size. Version 3 pieces stay editable, keep `Layout: 3`, and get the badge drawn over the end of their item row.
- Bands are always drawn and empty slots stay blank. Text shrinks to 70% and is then cut with "…".
- The stamp is drawn after any downscaling, so the geometry can be recomputed exactly from the saved file's dimensions.

**Saving:** into one subfolder per category inside the save folder (e.g. `Living/`), created on demand. The folder name is the category as typed, with characters Windows forbids stripped.

- Files are `category_YYYY-MM-DD_xxxx_NN.jpg` (xxxx is a random 4-char batch ID) plus a sidecar `category_YYYY-MM-DD_xxxx.txt` with labeled lines (Layout, Category, Item, Store, Price, Size, Rating, Seen, Date, Description).
- New photos keep full resolution at JPEG 0.95, capped at 10 MB: quality steps down first, then resolution (6000, 4096, 3200).
- A fully successful save clears the batch and resets the form. A download clears the batch but keeps the form filled.
- Older pieces in `Category/piece/info.txt` subfolders are still read and can still be edited.

**Edit mode:** opened from the gallery's pencil icon, or on desktop from "Edit a saved piece" (a file picker; the tool finds the sibling photos by prefix and loads the .txt).

- Filled fields are locked; empty ones can be filled and are drawn as an overlay with no backdrop.
- The rating and Seen IRL are never locked and are always redrawn; the stars and badge are opaque, so they cover the old ones.
- Overlay saves re-encode at 0.95 with no size cap.
- New photos dropped in edit mode get the full stamp and continue the numbering.
- Pieces whose layout isn't 3 or 4 are refused.

**Gallery tab:** one tile per photo, grouped and ordered by piece.

- Filters: search over item and description, category, store, a price range (parsed from text: commas, "k" suffix and Arabic digits are handled), rating (N and up, 5 only, unrated), seen IRL and sort (newest, price ascending or descending, rating).
- Clicking a photo opens a fullscreen viewer with arrows, keyboard and swipe. Thumbnails lazy-load.

**Decisions made (don't revisit):** no originals are kept; edits are overlay-only. No videos. No FB/IG link fetching. Category is required and everything else is optional. Drive for desktop deletions sync to Drive, which the user is fine with. Desktop keeps the local-folder flow (no sign-in); only phones use the Drive API.

**Known limits:** Drive mode needs a Google sign-in popup about once an hour of use (the OAuth app is in Testing mode, with no refresh tokens). A category folder created on the phone while the same one exists locally but hasn't synced yet can end up duplicated. Typos in already-filled fields can't be fixed without re-saving.

**Next steps:**

1. **Google sign-in setup (user does this):** in Google Cloud Console, create a project, enable the Drive API, set the OAuth consent screen to External in Testing with the user as a test user, and create a Web application client ID. Then paste it into `GOOGLE_CLIENT_ID` in `store.js`.
2. **Hosting over HTTPS:** GitHub Pages (needs a public repo), Netlify or Cloudflare Pages. The repo has no remote yet. Add the hosted address as an authorized JavaScript origin on the OAuth client.
3. **Real-device check of Drive mode,** which so far has only run against the fake Drive:
   - sign-in popup on iOS Safari and Android Chrome
   - the resumable upload's `Location` header being readable from the browser
   - `thumbnailLink` fetched with the auth header (it falls back to the full download if that fails)
   - finding the folder by search when it lives under "Computers" rather than My Drive
4. Fix anything the real-device run turns up, and extend the fake in `tests/helpers.js` to cover it.

**User preferences:** direct, concise answers, no padding. Keep designs simple; don't over-engineer.
