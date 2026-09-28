// Technohouse source B product page extractor.
// Selectors come from the product page HTML you provided:
//   Specifications -> .specification-table
//                      #basic-spec-div  : one flat list of .row.table-hr-remove
//                      #add-spec-div    : .row.justify-content-center blocks, each headed by <p class="fw-bold">
//                      a row is .att-title (label) + .att-value (value)
//   Description     -> .details-tab.seo-footer  (SEO block, h2/h3/p/a/figure)
//   Brand           -> first spec row labelled "Brand"
//   Image           -> JSON-LD / og:image / product gallery, description figure as last resort
// This script NEVER clicks Save / Publish.
(() => {
  if (window.__pdafTechnohouseB) {
    try { chrome.runtime.onMessage.removeListener(window.__pdafTechnohouseB); } catch { /* ignore */ }
  }
  const P = window.PDAF;
  // Every parsed section is kept; the filler decides how many to copy
  // (admin.js selectSpecSections).

  // ---------- Specifications ----------
  // One "Brand: BenQ" style block -> [{ label, value }]
  function rowsOf(block) {
    if (!block) return [];
    return P.$$('.row.table-hr-remove', block)
      .map((row) => ({
        label: P.text(P.$('.att-title', row)),
        value: P.text(P.$('.att-value', row)),
      }))
      .filter((row) => row.label && row.value);
  }

  function extractSpecs() {
    const groups = [];

    // Visible block: no headings, everything in one list
    const basic = P.$('#basic-spec-div') || P.$('.basic-spec-div');
    if (basic) {
      const rows = rowsOf(basic);
      if (rows.length) groups.push({ title: 'Basic Information', rows });
    }

    // "Show Additional Information" block: one section per .row, titled by <p class="fw-bold">
    const additional = P.$('#add-spec-div');
    if (additional) {
      for (const block of P.$$(':scope > .row', additional)) {
        const rows = rowsOf(block);
        if (!rows.length) continue;
        const heading = P.$('p.fw-bold', block);
        groups.push({ title: (heading && P.text(heading)) || 'Specifications', rows });
      }
    }

    // Fallback: the whole spec block, headings ignored
    if (!groups.length) {
      const rows = rowsOf(P.$('.specification-table'));
      if (rows.length) groups.push({ title: 'Specifications', rows });
    }
    return groups;
  }

  // ---------- Description ----------
  const DESCRIPTION_SELECTORS = [
    '.details-tab',
    '.seo-footer',
    '.card-body[itemscope]',
    '[itemscope="description"]',
    '#description',
    '.product-description',
  ];

  function extractDescription() {
    for (const selector of DESCRIPTION_SELECTORS) {
      const block = P.$(selector);
      if (!block) continue;
      const copy = block.cloneNode(true);
      // images live in <figure class="image">; cleanHtml drops them, drop the empty shell too
      copy.querySelectorAll('figure, script, style, .readmore-link').forEach((node) => node.remove());
      const html = P.cleanHtml(copy);
      if (P.text(block).length > 40 && html) return html; // skip stubs like "Description"
    }
    return '';
  }

  // ---------- Key features ----------
  // Quick Overview block: .overview .short-desc-attr ul.category-info li ("Display Size (Inch) - 27")
  const FEATURE_SELECTORS = [
    '.overview .category-info li',
    '.overview .short-desc-attr li',
    '.short-desc-attr li',
    '.overview li',
    '.key-features li', '.key-feature li', '.product-highlights li', '.highlights li',
    '#product-features li', '.short-description li', '.summary li', '.spec-highlight li',
  ];

  // ---------- Extract ----------
  function extract() {
    const productLd = P.jsonLdProduct();
    const sections = extractSpecs();

    const title =
      P.firstText(['h1.product-title', 'h1', '[itemprop="name"] h1', '.product-name h1']) ||
      (productLd && P.norm(productLd.name)) ||
      // Drops a trailing " - Site Name" style suffix, e.g. "Monitor - Store" -> "Monitor".
      // Last-resort fallback, so a generic pattern is safe and keeps the vendor
      // name out of the title.
      P.meta('og:title').replace(/\s*[|\-–—]\s*[^|\-–—]+$/, '').trim();

    const image =
      P.ldImage(productLd) ||
      P.abs(P.meta('og:image')) ||
      P.abs((P.$('.product-image img, .main-image img, #main-image, .swiper-slide img, [itemprop="image"]') || {}).src || '') ||
      P.abs((P.$('.details-tab figure.image img') || {}).src || '');

    // Brand usually sits in the basic spec block rather than in a page element.
    let brand = P.firstText(['.product-brand', '[itemprop="brand"] .att-title + .att-value', '.brand']);
    if (!brand) {
      for (const section of sections) {
        const brandRow = section.rows.find((row) => /^brand$/i.test(row.label));
        if (brandRow) { brand = brandRow.value; break; }
      }
    }

    return P.normalize({
      title,
      brand,
      image,
      features: P.listItems(FEATURE_SELECTORS),
      description: extractDescription(),
      specifications: sections,
    });
  }

  const onMessage = (message, _sender, sendResponse) => {
    if (message && message.type === 'PDAF_EXTRACT') {
      try {
        sendResponse({ ok: true, data: extract() });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);
  window.__pdafTechnohouseB = onMessage;
})();
