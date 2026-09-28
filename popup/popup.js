// ---- settings ----
const STORAGE_KEY = 'pdafProduct';   // the extracted product, kept between page loads
const DOWNLOAD_IMAGE = false;        // true = also save a copy to Downloads/product-images on extract
const AUTO_UPLOAD_IMAGE = true;      // let the page script push the image into the media library
const ADMIN_FORM_MARKERS = ['#product-name', '#product-slug']; // only on the admin product form

// Sites the extension can read, matched against the tab's hostname.
const SOURCES = [
  { label: 'Technohouse', host: /(^|\.)startech\.com\.bd$/i, file: 'content/technohouse-a.js' },
  { label: 'Technohouse', host: /(^|\.)ryans\.com$/i, file: 'content/technohouse-b.js' },
];

const $ = (id) => document.getElementById(id);
const state = { tab: null, source: null, admin: false, product: null, busy: false };

// ---------- UI helpers ----------
// The single message line under the buttons. kind: info | ok | warn | err
function say(text, kind = 'info') {
  const message = $('msg');
  message.textContent = text;
  message.className = 'msg ' + kind;
  message.hidden = !text;
}

const STATUS_ICONS = { ok: '\u2713', warn: '\u26a0', error: '\u2717', skip: '\u2013' };

// The per-field report shown after the form is filled.
function showReport(results) {
  const list = $('report');
  list.innerHTML = '';
  for (const { field, status, message } of results) {
    const item = document.createElement('li');
    item.className = 's-' + status;
    item.textContent = `${STATUS_ICONS[status] || '\u2022'} ${field}: ${message}`;
    list.appendChild(item);
  }
}

// Disables the buttons while an action is running.
function setBusy(busy) {
  state.busy = busy;
  render();
}

// Draws everything from `state`: the stored-product checklist, the thumbnail,
// and which buttons are usable.
function render() {
  const product = state.product;
  const specRows = product
    ? product.specifications.reduce((total, section) => total + section.rows.length, 0)
    : 0;

  const check = (key, found, detail) => {
    const item = document.querySelector(`#checks li[data-k="${key}"]`);
    item.classList.toggle('ok', !!found);
    item.querySelector('.ic').textContent = found ? '\u2713' : '\u2717';
    item.querySelector('em').textContent = detail ? ' ' + detail : '';
  };
  check('title', product && product.title);
  check('image', product && product.image);
  check('features', product && product.features.length,
    product && product.features.length ? `(${product.features.length})` : '');
  check('description', product && product.description,
    product && product.description ? `(${product.description.length} chars)` : '');
  check('specifications', specRows,
    specRows ? `(${product.specifications.length} sections, ${specRows} rows)` : '');

  const hasImage = !!(product && product.image);
  $('thumbLink').hidden = !hasImage;
  if (hasImage) {
    $('thumb').src = product.image;
    $('thumbLink').href = product.image;
  }

  const shownTitle = product && product.title.length > 60 ? product.title.slice(0, 60) + '\u2026' : (product && product.title);
  $('storedMeta').textContent = product
    ? `${shownTitle}\nFrom ${product.source}, ${new Date(product.extractedAt).toLocaleTimeString()}`
    : 'Nothing stored yet.';

  $('adminState').textContent = state.admin
    ? '\u2713 Admin product form detected on this tab'
    : 'Admin product form not detected on this tab (open your product add/edit page)';
  $('adminState').style.color = state.admin ? '#059669' : '#6b7280';

  $('extract').disabled = state.busy || !state.source;
  $('fill').disabled = state.busy || !state.admin || !product;
  $('clear').disabled = state.busy || !product;
  $('attach').disabled = state.busy || !state.admin || !product || !product.image;
}

// ---------- Tab and storage ----------
// Is the active tab the admin product form?
async function detectAdmin() {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: state.tab.id },
      func: (markers) => markers.every((marker) => document.querySelector(marker)),
      args: [ADMIN_FORM_MARKERS],
    });
    state.admin = !!(injection && injection.result);
  } catch {
    state.admin = false; // restricted page (chrome://, web store, ...)
  }
}

async function loadStored() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  state.product = stored[STORAGE_KEY] || null;
}

// The image as a data URL; only needed when the page script uploads it itself.
// The popup has host permissions for the source sites, so this fetch is not
// CORS-limited. Returns null on failure - the download already made at extract
// time stays available for a hand upload.
async function fetchImagePayload(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const blob = await response.blob();
    if (!/^image\//i.test(blob.type || '')) throw new Error('the server sent no image (' + (blob.type || 'no type') + ')');
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'product-image';
    return { name, type: blob.type, dataUrl };
  } catch {
    return null;
  }
}

// Optional, only used when DOWNLOAD_IMAGE is turned back on: saves the product
// image into the Downloads folder so it can be uploaded by hand.
// chrome.downloads fetches it outside the page, so no CORS/permission problem.
// Downloads/product-images/<product-name>.<ext>, keeping the source file type.
function imageFileName(product) {
  const extension = (() => {
    try {
      const fromUrl = (new URL(product.image).pathname.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
      return fromUrl ? fromUrl.toLowerCase() : 'jpg';
    } catch {
      return 'jpg';
    }
  })();
  const name = String(product.title || 'product')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'product';
  return `product-images/${name}.${extension}`;
}

// Returns { ok, id } or { ok: false, error }; null when there is nothing to do.
async function downloadImage(product) {
  if (!DOWNLOAD_IMAGE || !product.image) return null;
  try {
    const id = await chrome.downloads.download({
      url: product.image,
      filename: imageFileName(product),
      conflictAction: 'uniquify', // never overwrite an earlier download
      saveAs: false,
    });
    return { ok: true, id };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// ---------- Actions ----------
// Every action follows the same shape: guard, clear the report, show progress,
// run, report. Only the middle part differs, so it is the only argument.
async function runAction({ busyMessage, failurePrefix, guard, work }) {
  if (guard && !guard()) return;
  showReport([]);
  setBusy(true);
  say(busyMessage, 'info');
  try {
    await work();
  } catch (error) {
    say(`${failurePrefix}: ${error.message}`, 'err');
  } finally {
    setBusy(false);
  }
}

// Injects a content script into the active tab.
const injectScript = (files) =>
  chrome.scripting.executeScript({ target: { tabId: state.tab.id }, files });

// Sends a message to the content script and surfaces its error message.
async function sendToPage(message) {
  const response = await chrome.tabs.sendMessage(state.tab.id, message);
  if (!response) throw new Error('no response from the page script');
  if (!response.ok) throw new Error(response.error || 'the page script failed');
  return response;
}

// The fields the extractor found nothing for, named for the warning message.
function missingFields(data) {
  const missing = [];
  if (!data.image) missing.push('image');
  if (!data.features.length) missing.push('features');
  if (!data.description) missing.push('description');
  if (!data.specifications.length) missing.push('specifications');
  if (!data.brand) missing.push('brand');
  return missing;
}

// The fill ends with the form's publish click when every field came out clean.
function reportFill(results) {
  showReport(results);
  const count = (status) => results.filter((result) => result.status === status).length;
  const published = results.some((result) => result.field === 'Publish' && result.status === 'ok');
  const errors = count('error');
  const warnings = count('warn');
  const tail = published ? 'Publish was clicked.' : 'Review everything, then publish yourself.';
  if (errors) say(`Filled with ${errors} error(s). ${tail}`, 'err');
  else if (warnings) say('Filled, with some items to check. ' + tail, 'warn');
  else say('Filled. ' + tail, 'ok');
}

function onExtract() {
  return runAction({
    busyMessage: 'Extracting\u2026',
    failurePrefix: 'Extract failed',
    guard: () => {
      if (!state.source) { say('Open a Technohouse product page first.', 'err'); return false; }
      return true;
    },
    work: async () => {
      await injectScript(['content/common.js', state.source.file]);
      const { data } = await sendToPage({ type: 'PDAF_EXTRACT' });
      if (!data.title) throw new Error('could not find the product title. Is this a product page?');

      const product = { ...data, source: state.source.label, sourceUrl: state.tab.url, extractedAt: Date.now() };
      await chrome.storage.local.set({ [STORAGE_KEY]: product });
      state.product = product;

      // The image is fetched by the browser, so it needs no page permissions.
      const download = await downloadImage(product);
      if (download) {
        showReport([{
          field: 'Image',
          status: download.ok ? 'ok' : 'warn',
          message: download.ok
            ? 'downloaded to Downloads/product-images, kept as a hand-upload fallback'
            : 'could not download the image: ' + download.error,
        }]);
      }

      const missing = missingFields(data);
      say(
        missing.length
          ? `Extracted and stored, but nothing found for: ${missing.join(', ')}.`
          : 'Product extracted and stored.',
        missing.length ? 'warn' : 'ok'
      );
    },
  });
}

function onFill() {
  return runAction({
    busyMessage: 'Filling form\u2026',
    failurePrefix: 'Auto fill failed',
    guard: () => {
      if (!state.product) { say('Nothing stored. Extract a product first.', 'err'); return false; }
      if (!state.admin) { say('Open your admin product add/edit page in this tab first.', 'err'); return false; }
      return true;
    },
    work: async () => {
      await injectScript(['content/admin.js']);
      const image = AUTO_UPLOAD_IMAGE && state.product.image ? await fetchImagePayload(state.product.image) : null;
      const { results } = await sendToPage({ type: 'PDAF_FILL', product: state.product, image });
      reportFill(results);
    },
  });
}

function onAttach() {
  return runAction({
    busyMessage: 'Uploading image through the media library\u2026',
    failurePrefix: 'Upload failed',
    guard: () => {
      if (!state.product || !state.product.image) return false;
      return true;
    },
    work: async () => {
      await injectScript(['content/admin.js']);
      const image = await fetchImagePayload(state.product.image);
      const { results } = await sendToPage({ type: 'PDAF_ATTACH_IMAGE', image });
      showReport(results);
      const has = (status) => results.some((result) => result.status === status);
      const worst = has('error') ? 'error' : has('warn') ? 'warn' : 'ok';
      say(worst === 'ok' ? 'Image uploaded.' : 'Image upload needs a look, see below.', worst);
    },
  });
}

function onClear() {
  return runAction({
    busyMessage: 'Clearing\u2026',
    failurePrefix: 'Clear failed',
    work: async () => {
      await chrome.storage.local.remove(STORAGE_KEY);
      state.product = null;
      render();
      say('Stored product data cleared.', 'ok');
    },
  });
}

// ---------- Init ----------
(async function init() {
  $('extract').addEventListener('click', onExtract);
  $('fill').addEventListener('click', onFill);
  $('clear').addEventListener('click', onClear);
  $('attach').addEventListener('click', onAttach);   // re-runs just the thumbnail + gallery upload

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  let hostname = '';
  try { hostname = new URL(tab.url).hostname; } catch { /* no access to this tab */ }
  state.source = SOURCES.find((source) => source.host.test(hostname)) || null;
  $('source').textContent = state.source ? state.source.label : 'not a Technohouse page';

  await Promise.all([detectAdmin(), loadStored()]);
  render();
})();
