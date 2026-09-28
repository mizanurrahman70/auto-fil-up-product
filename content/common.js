// Shared helpers for the source extractors (technohouse-a.js / technohouse-b.js).
// Injected together with the site-specific file. Exposes window.PDAF.
(() => {
  if (window.PDAF && window.PDAF.v === 3) return; // v3: re-inject replaces stale helpers

  // ---------- Small DOM / text helpers ----------

  // Collapses runs of whitespace so scraped text stays on one line.
  const norm = (value) => (value || '').replace(/\s+/g, ' ').trim();

  // Text content of an element, normalised; '' for a missing element.
  const text = (element) => (element ? norm(element.textContent) : '');

  // Turns a possibly relative URL into an absolute one; '' when unusable.
  const abs = (url) => {
    try { return url ? new URL(url, location.href).href : ''; } catch { return ''; }
  };

  // querySelector / querySelectorAll, both safe against invalid selectors.
  const $ = (selector, root = document) => {
    try { return root.querySelector(selector); } catch { return null; }
  };
  const $$ = (selector, root = document) => {
    try { return [...root.querySelectorAll(selector)]; } catch { return []; }
  };

  // Content of a <meta> tag, looked up by property then name.
  const meta = (name) => {
    const tag = $(`meta[property="${name}"]`) || $(`meta[name="${name}"]`);
    return tag ? (tag.getAttribute('content') || '').trim() : '';
  };

  // First non-empty text among the given selectors, tried in order.
  function firstText(selectors, root = document) {
    for (const selector of selectors) {
      const found = text($(selector, root));
      if (found) return found;
    }
    return '';
  }

  // List items of the first selector that has any, de-duplicated and with the
  // "View more" style links removed.
  function listItems(selectors, root = document) {
    for (const selector of selectors) {
      const items = [
        ...new Set(
          $$(selector, root)
            .filter((item) => !item.classList.contains('view-more'))
            .map(text)
            .filter((value) => value && !/^view more/i.test(value))
        ),
      ];
      if (items.length) return items;
    }
    return [];
  }

  // ---------- JSON-LD (schema.org Product) ----------

  // The first Product object found in any JSON-LD block, following @graph links.
  function jsonLdProduct() {
    for (const script of $$('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent);
        const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (queue.length) {
          const node = queue.shift();
          if (!node || typeof node !== 'object') continue;
          if (Array.isArray(node['@graph'])) queue.push(...node['@graph']);
          const type = node['@type'];
          if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) return node;
        }
      } catch { /* ignore bad JSON-LD */ }
    }
    return null;
  }

  // image may be a string, an object with url, or a list of either.
  const ldImage = (product) => {
    if (!product) return '';
    let image = product.image;
    if (Array.isArray(image)) image = image[0];
    if (image && typeof image === 'object') image = image.url;
    return abs(image);
  };

  // brand may be a string or an object with a name.
  const ldBrand = (product) => {
    if (!product || !product.brand) return '';
    return norm(typeof product.brand === 'string' ? product.brand : product.brand.name);
  };

  // ---------- HTML cleaning for the description ----------

  // Tags kept (renamed, flattened), and tags removed outright.
  // 'a' is deliberately absent: links are unwrapped so the anchor tag disappears
  // but its text stays.
  const ALLOWED_TAGS = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 's',
    'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'code', 'pre',
  ]);
  const DROPPED_TAGS = new Set([
    'script', 'style', 'noscript', 'iframe', 'img', 'picture', 'video', 'audio', 'svg', 'canvas',
    'form', 'button', 'input', 'select', 'textarea', 'link', 'meta', 'figure', 'object', 'embed',
  ]);
  const RENAMED_TAGS = { h1: 'h2', h4: 'h3', h5: 'h3', h6: 'h3', b: 'strong', i: 'em' };

  // Returns a sanitized HTML string (no images, no links, no classes/styles).
  function cleanHtml(root) {
    if (!root) return '';
    const output = document.createElement('div');

    // Copies allowed nodes over, unwrapping everything else (div/span/section/...).
    const copyInto = (source, target) => {
      for (const node of source.childNodes) {
        if (node.nodeType === 3) {
          const value = node.nodeValue.replace(/\s+/g, ' ');
          if (value.trim() || target.lastChild) target.appendChild(document.createTextNode(value));
          continue;
        }
        if (node.nodeType !== 1) continue;
        const tag = node.tagName.toLowerCase();
        if (DROPPED_TAGS.has(tag) || node.hidden) continue;
        if (!ALLOWED_TAGS.has(tag)) {
          copyInto(node, target);
          continue;
        }
        const clone = document.createElement(RENAMED_TAGS[tag] || tag);
        copyInto(node, clone);
        target.appendChild(clone);
      }
    };
    copyInto(root, output);

    // Repeat until stable: emptying a wrapper can empty its parent too.
    for (let pass = 0; pass < 3; pass++) {
      output
        .querySelectorAll('p,li,h2,h3,ul,ol,strong,em,u,s,blockquote')
        .forEach((element) => {
          if (!norm(element.textContent) && !element.querySelector('br')) element.remove();
        });
    }
    return output.innerHTML.trim();
  }

  // ---------- Specifications ----------

  // Cell text with real line breaks: <br>, and the end of each li/p/div.
  function cellText(cell) {
    const copy = cell.cloneNode(true);
    copy.querySelectorAll('br').forEach((breakTag) => breakTag.replaceWith('\n'));
    copy.querySelectorAll('li,p,div').forEach((block) => block.append('\n'));
    return (copy.textContent || '').split('\n').map(norm).filter(Boolean).join('\n');
  }

  // Parses a spec table into [{ title, rows: [{ label, value }] }].
  // A row with a single cell (or a .heading-row cell) starts a new group.
  function parseSpecs(root) {
    if (!root) return [];
    const groups = [];
    let current = null;

    const startGroup = (title) => {
      current = { title: norm(title) || 'Specifications', rows: [] };
      groups.push(current);
      return current;
    };

    // 1) the normal case: a table
    $$('tr', root).forEach((row) => {
      const cells = [...row.children].filter((child) => /^t[dh]$/i.test(child.tagName));
      if (!cells.length) return;
      const isHeading =
        cells.length === 1 ||
        cells[0].classList.contains('heading-row') ||
        cells.every((cell) => cell.classList.contains('heading-row'));
      if (isHeading) {
        const heading = text(cells[0]);
        if (heading) startGroup(heading);
        return;
      }
      if (cells.length > 1 && cells.every((cell) => cell.tagName === 'TH')) return; // column header row
      const label = text(cells[0]);
      const value = cellText(cells[1]);
      if (!label || !value) return;
      (current || startGroup('Specifications')).rows.push({ label, value });
    });

    // 2) fallback: non-table markup (.name / .value pairs, optional .heading-row headings)
    if (groups.reduce((total, group) => total + group.rows.length, 0) < 2) {
      groups.length = 0;
      current = null;
      $$('.heading-row, .name', root).forEach((element) => {
        if (element.classList.contains('heading-row')) {
          const heading = text(element);
          if (heading) startGroup(heading);
          return;
        }
        const valueCell = element.nextElementSibling;
        if (valueCell && valueCell.classList.contains('value')) {
          const label = text(element);
          const value = cellText(valueCell);
          if (label && value) (current || startGroup('Specifications')).rows.push({ label, value });
        }
      });
    }

    // 3) fallback: definition lists
    if (!groups.some((group) => group.rows.length)) {
      const group = { title: 'Specifications', rows: [] };
      $$('dt', root).forEach((term) => {
        const definition = term.nextElementSibling;
        if (definition && definition.tagName === 'DD') {
          const label = text(term);
          const value = cellText(definition);
          if (label && value) group.rows.push({ label, value });
        }
      });
      if (group.rows.length) groups.push(group);
    }

    return groups.filter((group) => group.rows.length);
  }

  // ---------- Rebranding ----------

  // The store this extension publishes into.
  const STORE_NAME = 'Technohouse';

  // Source sites name themselves in their own copy ("Visit Ryans",
  // "Star Tech Bangladesh", "ryans.com"). Those mentions are swapped for the
  // store name so the details field reads as ours.
  //   star tech | startech | ryan | ryans
  const SOURCE_NAME = /\b(?:https?:\/\/)?(?:www\.)?(?:star\s?tech|ryans?)(?:\.com(?:\.bd)?)?\b/gi;

  // Replaces every source-name mention with the store name.
  const rebrand = (value) => String(value || '').replace(SOURCE_NAME, STORE_NAME);

  // ---------- Normalized shape ----------
  // The one product shape every site produces, so admin.js stays simple.
  function normalize(raw) {
    return {
      title: norm(raw.title),
      brand: norm(raw.brand),
      image: raw.image || '',
      features: [...new Set((raw.features || []).map(norm).filter(Boolean))],
      description: rebrand((raw.description || '').trim()),
      specifications: (raw.specifications || [])
        .map((group) => ({
          title: norm(group.title) || 'Specifications',
          rows: (group.rows || [])
            .map((row) => ({ label: norm(row.label), value: String(row.value || '').trim() }))
            .filter((row) => row.label && row.value),
        }))
        .filter((group) => group.rows.length),
    };
  }

  window.PDAF = {
    v: 3,
    norm, text, abs, $, $$, meta, firstText, listItems,
    jsonLdProduct, ldImage, ldBrand, cleanHtml, rebrand, parseSpecs, normalize,
  };
})();
