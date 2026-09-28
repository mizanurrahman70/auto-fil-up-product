// Technohouse source A product page extractor.
// Selectors marked [verified] were checked against the HTML you provided.
// Selectors marked [unverified] follow this site's usual layout but the pasted HTML
// stopped before those sections, so confirm them on a real page.
(() => {
  // Re-injection replaces the previous listener instead of piling up a second one.
  if (window.__pdafTechnohouseA) {
    try { chrome.runtime.onMessage.removeListener(window.__pdafTechnohouseA); } catch { /* ignore */ }
  }
  const P = window.PDAF;

  // Every parsed section is kept; the filler decides how many to copy
  // (see selectSpecSections in admin.js).

  function extractDescription() {
    // [unverified] #description (the "View More Info" link uses data-area="specification",
    // so the sibling section ids are very likely #specification / #description)
    const section = P.$('#description') || P.$('section.description') || P.$('.full-description');
    if (!section) return '';
    const copy = section.cloneNode(true);
    copy.querySelectorAll('.section-head').forEach((head) => head.remove());
    const heading = copy.querySelector('h2');
    if (heading && /^description$/i.test(P.text(heading))) heading.remove();
    return P.cleanHtml(copy);
  }

  function extractSpecs() {
    // [unverified] #specification table.data-table, rows: td.name / td.value, groups: td.heading-row
    return P.parseSpecs(P.$('#specification') || P.$('.specification') || P.$('table.data-table'));
  }

  function extract() {
    const productLd = P.jsonLdProduct();

    // [verified] h1.product-name
    const title = P.firstText(['h1.product-name', 'h1[itemprop="name"]', 'h1'])
      || (productLd && productLd.name) || '';

    // [verified] .product-img-holder img.main-img, meta[itemprop=image]
    const mainImage = P.$('.product-img-holder img.main-img') || P.$('.product-img-holder img');
    const image =
      P.abs(mainImage && mainImage.getAttribute('src')) ||
      P.abs((P.$('meta[itemprop="image"]') || {}).content) ||
      P.abs(P.meta('og:image')) ||
      P.ldImage(productLd);

    // [verified] td.product-brand
    const brand = P.firstText(['.product-brand', '[itemprop="brand"] [itemprop="name"]'])
      || P.ldBrand(productLd);

    // [verified] .short-description ul li (skips the "View More Info" item)
    const features = P.listItems(['.short-description ul li']);

    return P.normalize({
      title,
      brand,
      image,
      features,
      description: extractDescription(),
      specifications: extractSpecs(),
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
  window.__pdafTechnohouseA = onMessage;
})();
