import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { addPhoto, changedOutside, clickSave, fillForm, H, localFiles, openAsPhone, openWithLocalFolder, probe, toPng, W, type Files } from './helpers';

const DATE = /\d{4}-\d{2}-\d{2}/.source;
const pick = (files: Files, re: RegExp): Buffer[] => Object.entries(files).filter(([k]) => re.test(k)).map(([, v]) => v);

test.describe('desktop (local folder)', () => {
  test.beforeEach(async ({ page }) => { await openWithLocalFolder(page); });

  test('stamps a photo and saves it with its sidecar', async ({ page }) => {
    await addPhoto(page);
    await fillForm(page, { category: 'Living', item: 'Kivik sofa', store: 'IKEA', price: '24,500 EGP', size: '228×95×83 cm', description: 'Grey fabric, washable cover', rating: 3, seen: true });
    expect(await clickSave(page)).toMatch(/Saved 1 photo to .*Living\./);

    const files = await localFiles(page);
    const names = Object.keys(files);
    expect(names).toHaveLength(2);
    expect(names.some(n => new RegExp(`^Living/living_${DATE}_\\w{4}_01\\.jpg$`).test(n))).toBe(true);
    const txt = pick(files, /\.txt$/)[0].toString();
    expect(txt).toContain('Layout: 4\nCategory: Living\nItem: Kivik sofa\nStore: IKEA\nPrice: 24,500 EGP\nSize: 228×95×83 cm\nRating: 3\nSeen: yes\n');
    expect(txt).toContain('Description: Grey fabric, washable cover');

    const jpg = pick(files, /\.jpg$/)[0];
    expect(await probe(page, jpg)).toEqual({
      width: W, height: H,
      text: { description: true, item: true, category: true, store: true, price: true, size: true },
      stars: 3, seen: true, topBandDark: true, bottomBandDark: true,
    });
    expect(await toPng(page, jpg)).toMatchSnapshot('full-stamp.png', { maxDiffPixelRatio: 0.01 });

    // a full save resets the form for the next piece
    await expect(page.locator('#category')).toHaveValue('');
    await expect(page.locator('#thumbs li')).toHaveCount(0);
  });

  test('an unrated piece always gets a Rating line, also after the form resets', async ({ page }) => {
    for (const item of ['Stool', 'Bench']) {
      await addPhoto(page);
      await fillForm(page, { category: 'Living', item });
      await clickSave(page);
    }
    const txts = pick(await localFiles(page), /\.txt$/).map(b => b.toString());
    expect(txts).toHaveLength(2);
    for (const txt of txts) expect(txt).toContain('Rating: 0\nSeen: no\n');
  });

  test('downloads a stamped photo with empty slots left blank', async ({ page }) => {
    await addPhoto(page);
    await fillForm(page, { category: 'Tables', item: 'Oak desk' });
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    expect(download.suggestedFilename()).toMatch(new RegExp(`^tables_${DATE}_\\w{4}_01\\.jpg$`));

    const jpg = readFileSync(await download.path());
    expect(await probe(page, jpg)).toEqual({
      width: W, height: H,
      text: { description: false, item: true, category: true, store: false, price: false, size: false },
      stars: 0, seen: false, topBandDark: true, bottomBandDark: true,
    });
    expect(await toPng(page, jpg)).toMatchSnapshot('minimal-stamp.png', { maxDiffPixelRatio: 0.01 });
    expect(Object.keys(await localFiles(page))).toHaveLength(0);   // download doesn't touch the folder
  });

  test('autofills a known item from history', async ({ page }) => {
    await addPhoto(page);
    await fillForm(page, { category: 'Living', item: 'Kivik sofa', store: 'IKEA', size: '228×95×83 cm' });
    await clickSave(page);

    await page.fill('#item', 'Kivik sofa');
    await page.locator('#item').dispatchEvent('change');
    await expect(page.locator('#store')).toHaveValue('IKEA');
    await expect(page.locator('#size')).toHaveValue('228×95×83 cm');
    await expect(page.locator('#category')).toHaveValue('Living');
  });

  test('gallery lists, filters, sorts and opens pieces', async ({ page }) => {
    await addPhoto(page);
    await fillForm(page, { category: 'Living', item: 'Sofa', store: 'IKEA', price: '24,500 EGP', rating: 4 });
    await clickSave(page);
    await addPhoto(page); await addPhoto(page, '#6a8');
    await fillForm(page, { category: 'Dining', item: 'Table', store: 'Hub', price: '8k', description: 'Walnut top', rating: 2, seen: true });
    await clickSave(page);

    await page.click('#tabGallery');
    const count = page.locator('#gCount'), titles = page.locator('.card .t');
    await expect(count).toHaveText('3 of 3 photos (2 of 2 pieces)');

    await page.selectOption('#gCat', 'Dining');
    await expect(count).toHaveText('2 of 3 photos (1 of 2 pieces)');
    await page.click('#gReset');
    await page.fill('#gMin', '10000');
    await expect(titles).toHaveText(['Sofa']);
    await page.click('#gReset');
    await page.selectOption('#gRating', '4');
    await expect(titles).toHaveText(['Sofa']);
    await page.click('#gReset');
    await page.selectOption('#gSeen', 'yes');
    await expect(titles).toHaveText(['Table', 'Table']);
    await page.click('#gReset');
    await page.fill('#gSearch', 'walnut');
    await expect(titles).toHaveText(['Table', 'Table']);
    await page.click('#gReset');
    await page.selectOption('#gSort', 'priceAsc');
    await expect(titles).toHaveText(['Table', 'Table', 'Sofa']);

    await page.locator('.card .open').first().click();
    await expect(page.locator('#lbCaption')).toHaveText(/Table \| Hub \| 8k\s+\(1 \/ 3\)/);
    await expect(page.locator('#lbImg')).toHaveJSProperty('naturalWidth', W);
    await page.click('#lbNext');
    await expect(page.locator('#lbCaption')).toHaveText(/\(2 \/ 3\)/);
    await page.click('#lbClose');
    await expect(page.locator('#lightbox')).not.toBeVisible();
  });

  test('edit overlays only what changed and continues the numbering', async ({ page }) => {
    await addPhoto(page);
    await fillForm(page, { category: 'Bedroom', item: 'Malm bed', rating: 2 });
    await clickSave(page);
    const before = await localFiles(page);
    const [oldJpg] = pick(before, /_01\.jpg$/);

    await page.click('#tabGallery');
    await page.locator('.card .iconbtn').click();
    await expect(page.locator('#editBanner')).toBeVisible();
    await expect(page.locator('#item')).toHaveJSProperty('readOnly', true);     // filled: locked
    await expect(page.locator('#store')).toHaveJSProperty('readOnly', false);   // empty: can be filled
    await fillForm(page, { store: 'IKEA', rating: 5, seen: true });
    await addPhoto(page, '#58a');
    expect(await clickSave(page)).toMatch(/^Updated bedroom_/);

    const after = await localFiles(page);
    const base = Object.keys(before).find(n => n.endsWith('.txt'))!.slice(0, -4);
    expect(Object.keys(after).sort()).toEqual([`${base}.txt`, `${base}_01.jpg`, `${base}_02.jpg`]);
    const txt = pick(after, /\.txt$/)[0].toString();
    expect(txt).toMatch(/Item: Malm bed\nStore: IKEA\nRating: 5\nSeen: yes\n/);

    // saved photo: the store, stars and badge change; every other pixel stays put
    const [newJpg] = pick(after, /_01\.jpg$/);
    const p1 = await probe(page, newJpg);
    expect(p1.text).toMatchObject({ item: true, store: true, price: false });
    expect(p1.stars).toBe(5);
    expect(p1.seen).toBe(true);
    expect(await changedOutside(page, oldJpg, newJpg, ['store', 'stars', 'seen'])).toBeLessThan(0.005);

    // photo added in edit mode: full stamp with the merged info
    const p2 = await probe(page, pick(after, /_02\.jpg$/)[0]);
    expect(p2).toMatchObject({ stars: 5, seen: true, topBandDark: true, bottomBandDark: true });
    expect(p2.text).toMatchObject({ item: true, category: true, store: true, price: false });
  });
});

test('categories can be edited and are remembered', async ({ page }) => {
  await page.goto('/index.html');
  await page.click('#editCats');
  await page.fill('#catText', 'Kitchen\nOffice');
  await page.click('#catDialog .btn.primary');
  await expect(page.locator('#catList option')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('#catList option').first()).toHaveAttribute('value', 'Kitchen');
});

test.describe('phone (Google Drive)', () => {
  test('chooses a Drive folder, saves, and edits from the gallery', async ({ page }) => {
    const drive = await openAsPhone(page, { folderChosen: false });
    await expect(page.locator('body')).toHaveClass(/phone/);
    await expect(page.locator('#recent')).toBeHidden();
    await expect(page.locator('#folderName')).toHaveText('No folder chosen');

    await page.click('#chooseFolder');
    await page.fill('#driveQuery', 'furn');
    await page.click('#driveSearch');
    await page.locator('#driveResults button', { hasText: 'in My Drive' }).click();
    await expect(page.locator('#folderName')).toHaveText('Furniture');

    await addPhoto(page);
    await fillForm(page, { category: 'Living', item: 'Kivik sofa', store: 'IKEA', price: '24,500 EGP', rating: 3 });
    expect(await clickSave(page)).toBe('Saved 1 photo to Furniture/Living.');

    const saved = drive.files();
    expect(Object.keys(saved)).toEqual([expect.stringMatching(/^Living\/living_.*_01\.jpg$/), expect.stringMatching(/^Living\/living_.*\.txt$/)]);
    const [oldJpg] = pick(saved, /\.jpg$/);
    const p = await probe(page, oldJpg);
    expect(p).toMatchObject({ width: W, height: H, stars: 3, seen: false });
    expect(p.text).toMatchObject({ item: true, store: true, price: true, description: false });
    const ids = drive.ids();

    await expect(page.locator('#editBtn')).toHaveText('Edit from gallery');
    await page.click('#editBtn');
    await expect(page.locator('#galleryView')).toBeVisible();
    await expect(page.locator('#gCount')).toHaveText('1 of 1 photo (1 of 1 piece)');
    await page.locator('.card .iconbtn').click();
    await fillForm(page, { rating: 5, seen: true });
    expect(await clickSave(page)).toMatch(/^Updated living_/);

    expect(drive.ids()).toEqual(ids);   // replaced in place, same Drive files
    const edited = drive.files();
    expect(pick(edited, /\.txt$/)[0].toString()).toMatch(/Rating: 5\nSeen: yes\n/);
    const [newJpg] = pick(edited, /\.jpg$/);
    expect(await probe(page, newJpg)).toMatchObject({ stars: 5, seen: true });
    expect(await changedOutside(page, oldJpg, newJpg, ['stars', 'seen'])).toBeLessThan(0.005);
  });
});
