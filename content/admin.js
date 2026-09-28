// Admin product form filler.
// Selectors come from the admin HTML you provided:
//   #product-name, #product-slug, #product-brand      -> plain React-controlled inputs/selects
//   Quick overview / Details                          -> TipTap (ProseMirror) contenteditable, found via <section><h2>
//   Specifications                                    -> dynamic groups/rows. Ids contain the label text, so elements are
//                                                        located by id prefix/suffix and re-queried after every change.
//                                                        Sections/rows are added ONE AT A TIME and filled immediately, so
//                                                        the form never holds several blank rows/sections at once.
//   Files & media                                     -> click "Add thumbnail image" / "Add gallery images" box, the media
//                                                        library opens with <input type=file accept="image/*,...">, we set the file.
// This script NEVER clicks Save / Publish.
(() => {
  // Drop the previous copy's listener so a re-inject swaps the code instead of
  // leaving two listeners that both react to PDAF_FILL.
  if (window.__pdafAdmin) {
    try { chrome.runtime.onMessage.removeListener(window.__pdafAdmin); } catch { /* ignore */ }
  }
  window.__pdafAdmin3 = true;

  // ---- switches ----
  // How much of the source specification to copy:
  //   keep taking the next section until SPEC_TARGET_ROWS rows are filled,
  //   but stop as soon as one section alone already has SPEC_MIN_SECTION_ROWS
  //   rows or more - then no other section is copied.
  const SPEC_TARGET_ROWS = 8;
  const SPEC_MIN_SECTION_ROWS = 6;
  const MAX_ROWS_PER_SECTION = 0;    // 0 = every row of each section
  const FILL_NAME = false;           // false: never touch the product name/title
  const FILL_SLUG = false;           // false: never touch the product slug / URL slug
  const DEBUG = true;                // logs every write attempt to the page console
  const SET_SECTION_TITLE = false;   // false: keep the form's own section title ("Specifications"); true: use the source's ("Basic Information")
  const AUTO_UPLOAD_IMAGE = false;   // image is extracted only; upload it manually. Set true to re-enable media-library upload.

  // Safety limits, so a form that stops responding can never spin forever.
  const POINTER_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  const MAX_REMOVALS = 400;

  // helpers (this file is injected on its own, so it repeats a few of common.js)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (text) => (text || '').replace(/\s+/g, ' ').trim();
  const dbg = (...args) => { if (DEBUG) console.log('[pdaf specs]', ...args); };

  async function waitFor(fn, timeout = 2500, step = 40) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = fn();
      if (result) return result;
      await sleep(step);
    }
    return null;
  }

  // React tracks the value through the element's own property; calling the
  // prototype setter bypasses that tracker so React sees the change.
  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    // InputEvent (not plain Event) so both onChange and onInput handlers see it
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // The admin page groups its fields in <section><h2>Title</h2>...</section>
  function sectionByTitle(title) {
    const wanted = title.toLowerCase();
    return [...document.querySelectorAll('section')].find((section) => {
      const heading = section.querySelector('h2');
      return heading && norm(heading.textContent).toLowerCase() === wanted;
    });
  }

  // URL slug: 24" -> 24-inch, max 80 chars, never cut mid-word.
  // Only used when FILL_SLUG is turned on.
  const slugify = (title) => {
    let slug = String(title || '')
      .replace(/(\d)\s*["\u201D\u2033]/g, '$1 inch ')
      .replace(/&/g, ' and ')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (slug.length > 80) {
      const endsOnBoundary = slug[80] === '-';
      slug = slug.slice(0, 80);
      if (!endsOnBoundary && slug.includes('-')) slug = slug.slice(0, slug.lastIndexOf('-'));
    }
    return slug.replace(/-+$/g, '');
  };

  // ---------- plain inputs and the brand dropdown ----------
  function setInputById(id, value) {
    const input = document.getElementById(id);
    if (!input) throw new Error(`#${id} not found`);
    setNativeValue(input, value);
  }

  // Matches a brand ignoring case and punctuation ("BenQ" -> "benq"). Returns the
  // option's label, or false when the brand is not in the dropdown.
  function setBrand(brand) {
    const select = document.getElementById('product-brand');
    if (!select) throw new Error('#product-brand not found');
    const comparable = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const wanted = comparable(brand);
    const option = [...select.options].find(
      (candidate) => candidate.value && comparable(candidate.value) === wanted
    );
    if (!option) return false;
    setNativeValue(select, option.value);
    return option.textContent.trim();
  }

  // ---------- TipTap / ProseMirror ----------
  async function setEditorHtml(editor, html, plain) {
    const compact = (text) => (text || '').replace(/\s+/g, '');
    const expected = compact(plain).slice(0, 30);
    const landed = () => compact(editor.textContent).includes(expected);
    const selectAll = () => {
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    // 1) Synthetic paste: ProseMirror parses text/html itself, most reliable for TipTap
    selectAll();
    await sleep(80);
    const clipboard = new DataTransfer();
    clipboard.setData('text/html', html);
    clipboard.setData('text/plain', plain);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    if (await waitFor(landed, 700)) return 'paste';

    // 2) execCommand insertHTML
    selectAll();
    await sleep(80);
    document.execCommand('insertHTML', false, html);
    if (await waitFor(landed, 700)) return 'insertHTML';

    // 3) Direct DOM write (ProseMirror's mutation observer re-parses it)
    editor.innerHTML = html;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    if (await waitFor(landed, 700)) return 'innerHTML';

    throw new Error('editor did not accept the content');
  }

  // The TipTap editor of one form section ("Description", "Key features", ...).
  function editorIn(sectionTitle) {
    const section = sectionByTitle(sectionTitle);
    if (!section) throw new Error(`"${sectionTitle}" section not found`);
    const editor = section.querySelector('.ProseMirror[contenteditable="true"]');
    if (!editor) throw new Error(`editor in "${sectionTitle}" not found`);
    return editor;
  }

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ---------- Specifications ----------
  // The form renames its fields while you type (spec-row-0-0-Size-key) and gives
  // brand-new rows a different id scheme (spec-group-0-...-row-new-2-key), so ids
  // cannot be trusted for counting. Everything below is located by structure and
  // re-queried after every change, because React rebuilds rows on each keystroke.

  // Clicks whatever findButton() returns and waits until isDone() reports success.
  // A bare click is not always enough, so later attempts replay the full pointer
  // sequence a real click produces.
  async function clickUntilChanged(findButton, isDone, { attempts = 3, timeout = 2000 } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const button = findButton();
      if (!button) return false;
      if (attempt === 1) {
        button.click();
      } else {
        button.scrollIntoView({ block: 'center' });
        await sleep(120);
        for (const type of POINTER_EVENTS) {
          button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      }
      if (await waitFor(isDone, timeout)) return true;
    }
    return false;
  }

  function buttonByText(root, text, { partial = false } = {}) {
    const wanted = text.toLowerCase();
    if (!root) return null;
    return (
      [...root.querySelectorAll('button')].find((button) => {
        const label = norm(button.textContent).toLowerCase();
        return partial ? label.includes(wanted) : label === wanted;
      }) || null
    );
  }

  // ---- form structure (no ids, no positional assumptions) ----
  // A specification section is the element that holds "Remove section" + "+ Add row".
  const specSectionElements = (specSection) =>
    [...specSection.querySelectorAll('button')]
      .filter((button) => norm(button.textContent).toLowerCase() === 'remove section')
      .map((button) => {
        let element = button.parentElement;
        while (element && element !== specSection && !buttonByText(element, '+ add row')) {
          element = element.parentElement;
        }
        return element && element !== specSection ? element : null;
      })
      .filter(Boolean);

  // A row is the grid holding one input + one textarea + its own "Remove" button.
  const specRowBoxes = (groupElement) =>
    groupElement
      ? [...groupElement.querySelectorAll('div.grid')].filter(
          (box) => box.querySelector('input') && box.querySelector('textarea')
        )
      : [];
  const specRowCount = (groupElement) => specRowBoxes(groupElement).length;

  // The section title input sits in the header row, next to "Remove section".
  const specTitleInput = (groupElement) => {
    const header = groupElement && buttonByText(groupElement, 'remove section')?.parentElement;
    return header ? header.querySelector('input') : null;
  };

  // The fields of one row. The row holding the wanted label wins, because the DOM
  // is rebuilt whenever the label changes; otherwise fall back to the row's place.
  function specRowFields(groupElement, position, label) {
    const boxes = specRowBoxes(groupElement);
    if (!boxes.length) return { labelField: null, valueField: null };
    const wanted = String(label || '').trim();
    const box =
      (wanted && boxes.find((candidate) => candidate.querySelector('input')?.value.trim() === wanted)) ||
      boxes[position] ||
      boxes[boxes.length - 1];
    return { labelField: box.querySelector('input'), valueField: box.querySelector('textarea') };
  }

  // ---- writing text the form accepts ----
  // A real text insertion fires the trusted input events React listens to; the
  // native setter is only the fallback.
  function forceValue(element, value) {
    if (!element) return false;
    const preview = (text) => JSON.stringify(String(text).slice(0, 40));
    dbg('write', element.tagName, element.id || '(no id)', '=', preview(value));
    if (element.value === value) return true;
    if (element.disabled || element.readOnly) dbg('!! element is disabled/readOnly, cannot write');
    try { element.focus({ preventScroll: true }); } catch { /* ignore */ }
    try { element.select(); } catch { /* ignore */ }
    try {
      const inserted = document.execCommand('insertText', false, value);
      dbg('insertText returned', inserted, '-> now', preview(element.value));
    } catch (error) { dbg('insertText threw', error.message); }
    if (element.value === value) return true;
    setNativeValue(element, value);
    dbg('native setter -> now', preview(element.value));
    return element.value === value;
  }

  // Writes and confirms. The field getter runs again on every attempt, because the
  // element is replaced whenever the label (and therefore the id) changes.
  async function setVerified(getField, value) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const field = getField();
      if (!field) { dbg(`attempt ${attempt}: field not found for`, value); await sleep(120); continue; }
      forceValue(field, value);
      await sleep(150);
      const readBack = getField();
      dbg(`attempt ${attempt}: wanted`, value, '| read back', readBack ? readBack.value : 'field gone');
      if (readBack && readBack.value === value) return true;
    }
    return false;
  }

  // ---- which source sections to copy ----
  // Sections are taken in order until SPEC_TARGET_ROWS rows are covered; a section
  // that already has SPEC_MIN_SECTION_ROWS rows or more is used alone, and then no
  // other section is copied.
  function selectSpecSections(sections) {
    const selected = [];
    let rows = 0;
    for (const candidate of sections || []) {
      if (!candidate || !candidate.rows || !candidate.rows.length) continue;
      selected.push(candidate);
      rows += candidate.rows.length;
      if (rows >= SPEC_TARGET_ROWS) break;                // target reached
      if (candidate.rows.length >= SPEC_MIN_SECTION_ROWS) break; // this one section is enough
    }
    return selected.map((section) =>
      MAX_ROWS_PER_SECTION
        ? { ...section, rows: section.rows.slice(0, MAX_ROWS_PER_SECTION) }
        : section
    );
  }

  // Reads the form back and reports which rows did not land.
  function verifySpecRows(specSection, wantedSections) {
    const sectionElements = specSectionElements(specSection);
    const mismatched = [];
    let checked = 0;
    wantedSections.forEach((source, sectionIndex) => {
      source.rows.forEach((row, rowIndex) => {
        checked++;
        const { labelField, valueField } = specRowFields(sectionElements[sectionIndex], rowIndex, row.label);
        if (labelField?.value !== row.label || valueField?.value !== row.value) mismatched.push(row.label);
      });
    });
    return { checked, mismatched };
  }

  async function fillSpecs(sourceSections) {
    const wantedSections = selectSpecSections(sourceSections);
    if (!wantedSections.length) throw new Error('no specification rows to fill');

    const specSection = sectionByTitle('Specifications');
    if (!specSection) throw new Error('Specifications section not found');

    // Several sections each get the source's title; a single one keeps the
    // form's own default ("Specifications").
    const useSourceTitles = SET_SECTION_TITLE || wantedSections.length > 1;
    const problems = []; // collected and reported, never thrown mid-way

    const sectionCount = () => specSectionElements(specSection).length;

    // Bring the form to the wanted number of sections, dropping the last ones.
    while (sectionCount() > wantedSections.length) {
      const present = specSectionElements(specSection);
      const removed = await clickUntilChanged(
        () => buttonByText(present[present.length - 1], 'remove section'),
        () => sectionCount() < present.length,
        { attempts: 2, timeout: 1500 }
      );
      if (!removed) { problems.push('could not remove a surplus specification section'); break; }
      await sleep(60);
    }

    for (const [sectionIndex, source] of wantedSections.entries()) {
      const groupElement = () => specSectionElements(specSection)[sectionIndex];
      const wantedRows = source.rows.length;

      // Create the section only when we reach it, then title it right away.
      if (!groupElement()) {
        const added = await clickUntilChanged(
          () => buttonByText(specSection, 'add specification section', { partial: true }),
          () => sectionCount() > sectionIndex,
          { attempts: 2, timeout: 2000 }
        );
        if (!added) { problems.push('could not add another specification section'); break; }
        await sleep(100);
      }

      const titleField = () => specTitleInput(groupElement());
      const currentTitle = titleField()?.value.trim();
      if (useSourceTitles || !currentTitle) {
        const title = useSourceTitles ? source.title : 'Specifications';
        if (!(await setVerified(titleField, title))) problems.push(`section title "${title}"`);
      }

      // Drop rows the form already has but the source does not.
      let safety = 0;
      while (specRowCount(groupElement()) > wantedRows && safety++ < MAX_REMOVALS) {
        const boxes = specRowBoxes(groupElement());
        const removed = await clickUntilChanged(
          () => buttonByText(boxes[boxes.length - 1], 'remove'),
          () => specRowCount(groupElement()) < boxes.length,
          { attempts: 2, timeout: 1500 }
        );
        if (!removed) { problems.push(`could not remove a surplus row in "${source.title}"`); break; }
        await sleep(60);
      }

      // Rows: add one, fill it, move on.
      for (const [rowIndex, row] of source.rows.entries()) {
        if (specRowCount(groupElement()) <= rowIndex) {
          const before = specRowCount(groupElement());
          const added = await clickUntilChanged(
            () => buttonByText(groupElement(), '+ add row'),
            () => specRowCount(groupElement()) > before
          );
          if (!added) {
            problems.push(`"+ Add row" stopped working at row ${rowIndex + 1} (form had ${before})`);
            break; // keep what was filled; the rest is reported as unchecked
          }
          await sleep(120);
        }

        const wroteLabel = await setVerified(
          () => specRowFields(groupElement(), rowIndex, row.label).labelField,
          row.label
        );
        await sleep(120); // the label write rebuilds the row before the value is set
        const wroteValue = await setVerified(
          () => specRowFields(groupElement(), rowIndex, row.label).valueField,
          row.value
        );
        if (!wroteLabel || !wroteValue) problems.push(`${source.title} / ${row.label}`);
      }
    }

    const { checked, mismatched } = verifySpecRows(specSection, wantedSections);
    return { sections: wantedSections.length, checked, mismatched, problems };
  }

  // ---------- Image upload through the media library ----------
  // Only used when AUTO_UPLOAD_IMAGE is turned on; otherwise the image is just
  // downloaded to your computer and you upload it by hand.
  const imageFileInputs = () =>
    [...document.querySelectorAll('input[type="file"]')].filter((input) => !/pdf/i.test(input.accept || ''));

  // The drop box for a kind of image, found by its accessible label.
  function findUploadBox(kind) {
    const needle = kind === 'thumbnail' ? 'thumbnail image' : 'gallery image';
    const byAriaLabel = [...document.querySelectorAll('button[aria-label]')].find((button) =>
      button.getAttribute('aria-label').toLowerCase().includes(needle)
    );
    if (byAriaLabel) return byAriaLabel;
    const label = [...document.querySelectorAll('label')].find((candidate) =>
      norm(candidate.textContent).toLowerCase().includes(needle)
    );
    const wrapper = label && label.closest('.space-y-2');
    return wrapper && wrapper.querySelector('button[class*="aspect-square"]');
  }

  // dataUrl -> File, for handing the image to the media library's file input.
  function toFile(image) {
    const [header, base64] = image.dataUrl.split(',');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const type = image.type || (header.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    return new File([bytes], image.name, { type });
  }

  async function uploadToBox(kind, image) {
    const box = findUploadBox(kind);
    if (!box) throw new Error(`"${kind}" upload box not found`);

    // Opening the library adds a fresh file input; that is how we know it appeared.
    const before = new Set(imageFileInputs());
    const newFileInput = () => imageFileInputs().find((input) => !before.has(input));
    box.click();

    let fileInput = await waitFor(newFileInput, 2500);
    if (!fileInput) {
      // The library may open on an "Upload" tab instead of showing the input at once
      const dialog = document.querySelector('dialog[open], [role="dialog"]');
      const uploadTab = dialog && [...dialog.querySelectorAll('button,[role="tab"]')]
        .find((candidate) => /^upload/i.test(norm(candidate.textContent)));
      if (uploadTab) {
        uploadTab.click();
        fileInput = await waitFor(newFileInput, 2500);
      }
    }
    if (!fileInput) fileInput = imageFileInputs().filter((input) => input.isConnected).pop();
    if (!fileInput) throw new Error('media library did not show a file input');

    const transfer = new DataTransfer();
    transfer.items.add(toFile(image));
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    // The upload is done once the library closes, which removes the input.
    if (await waitFor(() => !fileInput.isConnected, 12000, 100)) {
      await sleep(500);
      return { status: 'ok', message: `${image.name} uploaded` };
    }
    return {
      status: 'warn',
      message: 'file sent, but the media library is still open. Pick/confirm the uploaded image there.',
    };
  }

  // Thumbnail first, then gallery; stops early if the library is still open,
  // because a second dialog cannot be stacked on the first one.
  async function uploadImages(image) {
    const reports = [];
    for (const [kind, label] of [['thumbnail', 'Thumbnail'], ['gallery', 'Gallery']]) {
      try {
        const report = await uploadToBox(kind, image);
        reports.push({ field: label, status: report.status, message: report.message });
        if (report.status !== 'ok') break;
      } catch (error) {
        reports.push({ field: label, status: 'error', message: error.message });
      }
    }
    return reports;
  }

  // ---------- On-page result panel ----------
  // The popup closes while the page keeps working, so the report is also shown
  // on the page itself.
  const STATUS_ICONS = { ok: '\u2713', warn: '\u26a0', error: '\u2717', skip: '\u2013' };
  const STATUS_COLORS = { ok: '#059669', warn: '#d97706', error: '#dc2626', skip: '#9ca3af' };

  function showToast(results) {
    document.getElementById('pdaf-toast')?.remove();

    const panel = document.createElement('div');
    panel.id = 'pdaf-toast';
    panel.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:380px;background:#fff;color:#1f2937;' +
      'border:1px solid #d1d5db;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.18);' +
      'font:12px/1.45 system-ui,sans-serif;padding:10px 12px';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;gap:12px;font-weight:600;margin-bottom:4px';
    const title = document.createElement('span');
    title.textContent = 'Product Data Auto Filler: review, then Save yourself';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '\u00d7';
    close.style.cssText = 'border:0;background:none;cursor:pointer;font-size:16px;line-height:1';
    close.onclick = () => panel.remove();
    header.append(title, close);
    panel.append(header);

    for (const { field, status, message } of results) {
      const line = document.createElement('div');
      line.style.color = STATUS_COLORS[status] || '#1f2937';
      line.textContent = `${STATUS_ICONS[status] || '\u2022'} ${field}: ${message}`;
      panel.append(line);
    }

    document.body.append(panel);
    setTimeout(() => panel.remove(), 45000); // do not stay in the way forever
  }

  // ---------- Main ----------
  function onMessage(msg, _sender, sendResponse) {
    if (!msg) return;
    if (msg.type === 'PDAF_FILL') {
      fill(msg.product, msg.image)
        .then((results) => sendResponse({ ok: true, results }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true; // async response
    }
    if (msg.type === 'PDAF_ATTACH_IMAGE') {
      (async () => {
        if (!AUTO_UPLOAD_IMAGE) return sendResponse({ ok: false, error: 'image auto-upload is disabled in admin.js' });
        if (!msg.image) return sendResponse({ ok: false, error: 'the extension could not download the image' });
        const results = await uploadImages(msg.image);
        showToast(results);
        sendResponse({ ok: true, results });
      })().catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
  }

  async function fill(product, image) {
    const results = [];
    const record = (field, status, message) => results.push({ field, status, message });
    // One form field per step: a failure is reported, the rest still run.
    const step = async (field, work) => {
      try { await work(); } catch (error) { record(field, 'error', error.message); }
    };

    // Name and slug are yours to write: the extension never touches them.
    if (FILL_NAME && product.title) {
      await step('Name', async () => {
        setInputById('product-name', product.title);
        record('Name', 'ok', 'filled');
      });
      await sleep(150); // let any auto-slug logic run first, then set ours
      await step('Slug', async () => {
        const slug = slugify(product.title);
        setInputById('product-slug', slug);
        record('Slug', 'ok', slug);
      });
    } else {
      record('Name', 'skip', 'left as you typed it');
      record('Slug', 'skip', 'left as you typed it');
    }

    if (product.brand) {
      await step('Brand', async () => {
        const matched = setBrand(product.brand);
        if (matched) record('Brand', 'ok', matched);
        else record('Brand', 'warn', `"${product.brand}" is not in the brand dropdown, left unchanged`);
      });
    } else record('Brand', 'skip', 'no brand found on the source page');

    if (product.features && product.features.length) {
      await step('Key features', async () => {
        const html = '<ul>' + product.features.map((f) => `<li>${esc(f)}</li>`).join('') + '</ul>';
        const how = await setEditorHtml(editorIn('Quick overview'), html, product.features.join('\n'));
        record('Key features', 'ok', `Quick overview filled (${how})`);
      });
    } else record('Key features', 'skip', 'none stored');

    if (product.description) {
      await step('Description', async () => {
        const plain = new DOMParser().parseFromString(product.description, 'text/html').body.textContent || '';
        const how = await setEditorHtml(editorIn('Details'), product.description, plain);
        record('Description', 'ok', `Details filled (${how})`);
      });
    } else record('Description', 'skip', 'none stored');

    if (product.specifications && product.specifications.length) {
      await step('Specifications', async () => {
        const { sections, checked, mismatched, problems } = await fillSpecs(product.specifications);
        if (!mismatched.length && !problems.length) {
          record('Specifications', 'ok', `${sections} section(s), ${checked} rows`);
          return;
        }
        const notes = [...new Set([...problems, ...mismatched])].slice(0, 4).join(', ');
        record('Specifications', 'warn', `${checked - mismatched.length}/${checked} rows verified. Check: ${notes}`);
      });
    } else record('Specifications', 'skip', 'none stored');

    // Image: downloaded to your computer on extract, but NOT filled (upload manually).
    if (product.image && !AUTO_UPLOAD_IMAGE) {
      record('Image', 'skip', 'not filled: the image was downloaded to Downloads/product-images, upload it yourself');
    } else if (product.image) {
      if (!image) record('Image', 'warn', 'the extension could not download the image');
      else {
        try {
          (await uploadImages(image)).forEach((result) => record(result.field, result.status, result.message));
        } catch (error) {
          record('Image', 'error', error.message);
        }
      }
    } else record('Image', 'skip', 'none stored');

    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    showToast(results);
    return results;
  }

  chrome.runtime.onMessage.addListener(onMessage);
  // Re-injection replaces the previous copy instead of leaving two listeners behind.
  window.__pdafAdmin = onMessage;
})();
