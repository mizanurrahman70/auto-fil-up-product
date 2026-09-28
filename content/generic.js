// Generic product page extractor, used for any source that has no dedicated
// file. Nothing here is site-specific: schema.org JSON-LD carries most of the
// product, and the selectors after it are the ones shops share (OpenGraph,
// itemprop, a spec table, a feature list).
// It returns less than a dedicated extractor would on an awkward layout, so
// technohouse-a.js / technohouse-b.js still take precedence where they match.
(() => {
  // Re-injection replaces the previous listener instead of piling up a second one.
  if (window.__pdafGeneric) {
    try { chrome.runtime.onMessage.removeListener(window.__pdafGeneric); } catch { /* ignore */ }
  }
  const P = window.PDAF;

  // ---------- Images ----------
  // A shop's gallery usually has several, but the admin form takes one picture
  // per fill, so the first real one wins and the rest are ignored.
  const IMAGE_SELECTORS = [
    '[itemprop="image"]',
    '.product-image img', '.product-gallery img', '.gallery img',
    '.product-img-holder img', '#main-image', '.zoom-image',
  ];

  // The largest of a <picture>/srcset group, which is the one worth uploading.
  function widestSrcset(element) {
    const options = (element.getAttribute('srcset') || '')
      .split(',')
      .map((entry) => {
        const [url, size] = entry.trim().split(/\s+/);
        return { url, width: parseInt(size, 10) || (size && size.endsWith('w') ? parseInt(size, 10) : 0) };
      })
      .filter((entry) => entry.url);
    if (!options.length) return '';
    return options.sort((a, b) => b.width - a.width)[0].url;
  }

  function firstImage(product) {
    const fromLd = P.ldImage(product);
    if (fromLd) return fromLd;
    const openGraph = P.abs(P.meta('og:image'));
    if (openGraph) return openGraph;
    for (const selector of IMAGE_SELECTORS) {
      const element = P.$(selector);
      if (!element) continue;
      const src = widestSrcset(element) || element.currentSrc || element.getAttribute('src') || element.getAttribute('data-src') || '';
      const absolute = P.abs(src);
      // Decorative icons and tracking pixels are not the product.
      if (absolute && !/sprite|placeholder|blank|loading|1x1|spacer/i.test(absolute)) return absolute;
    }
    return '';
  }

  // ---------- Title ----------
  // "Monitor - Some Store" -> "Monitor". Last resort only, so a generic pattern
  // is safe and the shop's own name stays out of the title.
  const titleFromPage = () => P.meta('og:title').replace(/\s*[|\u2013\u2014-]\s*[^|\u2013\u2014-]+$/, '').trim();

  // ---------- Specifications ----------
  // JSON-LD: additionalProperty is a flat list of PropertyValue pairs, which
  // becomes one group.
  function ldSpecs(product) {
    const properties = product && product.additionalProperty;
    const list = Array.isArray(properties) ? properties : properties ? [properties] : [];
    const rows = list
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const label = P.norm(entry.name || entry.propertyID);
        const value = P.norm(Array.isArray(entry.value) ? entry.value.join(', ') : entry.value);
        return label && value ? { label, value } : null;
      })
      .filter(Boolean);
    return rows.length ? [{ title: 'Specifications', rows }] : [];
  }

  // The blocks most shops keep their spec sheet in. A bare "table" is left out
  // on purpose: it would happily match a cart or shipping table.
  const SPEC_SELECTORS = [
    '#specification', '#specifications', '#product-specification', '#specs', '#technical-specs',
    '[id*="specification" i]', '[id*="technical-spec" i]',
    '[class*="specification" i]', '[class*="tech-spec" i]', '[class*="spec-table" i]',
    'table.specs', 'table.spec', '.specs table', '.specification table',
  ];

  // Any table with real label/value pairs will do, but only once the selectors
  // above have come up short, so a cart table is never the last word.
  function extractSpecs(product) {
    for (const selector of SPEC_SELECTORS) {
      const groups = P.parseSpecs(P.$(selector)).filter((group) => group.rows.length);
      if (groups.reduce((total, group) => total + group.rows.length, 0) >= 2) return groups;
    }
    const tables = [...document.querySelectorAll('table')]
      .map((table) => P.parseSpecs(table))
      .filter((groups) => groups.reduce((total, group) => total + group.rows.length, 0) >= 2);
    if (tables.length) return tables[0];
    return ldSpecs(product);
  }

  // ---------- Description ----------
  const DESCRIPTION_SELECTORS = [
    '[itemprop="description"]', '#description', '#product-description', '.product-description',
    '.product-description-content', '.product-details', '.description-content', '.full-description',
    '[class*="product-detail" i]', 'main article', 'article',
  ];

  // Plain text (a JSON-LD description) becomes paragraphs, so the admin editor
  // gets the same shape as an HTML one.
  function paragraphsFromText(text) {
    const body = (text || '').split(/\n{2,}|\r\n{2,}/).map((block) => block.trim()).filter(Boolean);
    if (!body.length) return '';
    return body.map((block) => `<p>${block.replace(/\n/g, '<br>')}</p>`).join('');
  }

  function extractDescription(product) {
    for (const selector of DESCRIPTION_SELECTORS) {
      const block = P.$(selector);
      if (!block) continue;
      const html = P.cleanHtml(block);
      if (html && P.text(block).length > 60) return html;
    }
    return paragraphsFromText(product && product.description);
  }

  // ---------- Key features ----------
  // Shops have no standard place for these, so every list in a block that talks
  // about features is tried, longest usable one first.
  const FEATURE_SELECTORS = [
    '#features li', '.features li', '.feature-list li',
    '.key-features li', '.key-feature li', '.product-highlights li', '.highlights li',
    '.quick-overview li', '.short-description li', '.product-features li', '.summary li',
    '[class*="highlight" i] li', '[class*="feature" i] li',
  ];

  function extractFeatures() {
    let best = [];
    for (const selector of FEATURE_SELECTORS) {
      const items = P.listItems([selector]);
      if (items.length > best.length) best = items;
    }
    return best;
  }

  // ---------- Brand ----------
  const BRAND_SELECTORS = [
    '[itemprop="brand"] [itemprop="name"]', '[itemprop="brand"]', '.brand-name', '.product-brand',
    '#brand', '.brand a', '[class*="brand-name" i]', '[class*="brand" i] a', '[class*="brand" i]',
  ];
  // Row labels worth treating as the brand when there is no brand element.
  const BRAND_ROW_LABELS = /^(brand|brand\s*name|manufacturer|vendor|make|brand\s*\(\s*a\s*\)|brand\s*model)$/i;

  function extractBrand(product, sections) {
    const fromLd = P.ldBrand(product);
    if (fromLd) return fromLd;
    for (const selector of BRAND_SELECTORS) {
      const found = P.text(P.$(selector));
      if (found && found.length < 60) return found;
    }
    for (const section of sections) {
      const row = section.rows.find((candidate) => BRAND_ROW_LABELS.test(candidate.label));
      if (row) return row.value;
    }
    return '';
  }

  // ---------- Extract ----------
  function extract() {
    const productLd = P.jsonLdProduct();
    const sections = extractSpecs(productLd);

    const title =
      P.norm((productLd && productLd.name) || '') ||
      P.firstText(['h1[itemprop="name"]', '.product-title h1', '.product-name h1', 'h1']) ||
      titleFromPage();

    return P.normalize({
      title,
      brand: extractBrand(productLd, sections),
      image: firstImage(productLd),
      features: extractFeatures(),
      description: extractDescription(productLd),
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
  window.__pdafGeneric = onMessage;
})();
