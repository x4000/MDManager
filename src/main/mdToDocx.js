// Markdown → .docx converter (dependency-free OOXML writer).
//
// There's no pandoc / docx library available at runtime, so we build a minimal
// but valid Word document by hand: walk markdown-it's token stream into
// WordprocessingML paragraphs, then pack the parts into a "stored" (uncompressed)
// ZIP — which Word opens fine. Covers the common constructs: headings,
// paragraphs, bold/italic/strike/inline-code, links, bullet/ordered lists
// (incl. nesting), blockquotes, fenced/indented code blocks, horizontal rules,
// images (as alt text), and GFM tables.

const MarkdownIt = require('markdown-it');
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

// ── XML helpers ──────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A single run: text with formatting. rPr children are emitted in the order the
// OOXML schema (CT_RPr) requires — Word can reject a document with out-of-order
// run properties.
function run(text, o) {
  o = o || {};
  const rpr = [];
  if (o.code) rpr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
  else if (o.font) rpr.push(`<w:rFonts w:ascii="${o.font}" w:hAnsi="${o.font}"/>`);
  if (o.b) rpr.push('<w:b/>');
  if (o.i) rpr.push('<w:i/>');
  if (o.strike) rpr.push('<w:strike/>');
  if (o.link) rpr.push('<w:color w:val="0563C1"/>');
  if (o.sz) rpr.push(`<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>`);
  if (o.link) rpr.push('<w:u w:val="single"/>');
  if (o.code) rpr.push('<w:shd w:val="clear" w:color="auto" w:fill="EFEFEF"/>');
  const rprXml = rpr.length ? `<w:rPr>${rpr.join('')}</w:rPr>` : '';
  return `<w:r>${rprXml}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}
function brRun() { return '<w:r><w:br/></w:r>'; }

// A paragraph from already-built run XML, with optional formatting props.
function para(runsXml, o) {
  o = o || {};
  const ppr = [];
  if (o.style) ppr.push(`<w:pStyle w:val="${o.style}"/>`);
  if (o.indentLeft != null || o.hanging != null) {
    const left = o.indentLeft != null ? ` w:left="${o.indentLeft}"` : '';
    const hang = o.hanging != null ? ` w:hanging="${o.hanging}"` : '';
    ppr.push(`<w:ind${left}${hang}/>`);
  }
  if (o.shd) ppr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${o.shd}"/>`);
  if (o.border) ppr.push('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr>');
  const spaceBefore = o.before != null ? o.before : 0;
  const spaceAfter = o.after != null ? o.after : 120;
  ppr.push(`<w:spacing w:before="${spaceBefore}" w:after="${spaceAfter}"/>`);
  const pprXml = ppr.length ? `<w:pPr>${ppr.join('')}</w:pPr>` : '';
  return `<w:p>${pprXml}${runsXml || ''}</w:p>`;
}

// Heading sizes in half-points (h1 = 24pt … h6 = 12pt).
const HEADING_SZ = { 1: 48, 2: 40, 3: 32, 4: 28, 5: 26, 6: 24 };

// ── Inline → runs ────────────────────────────────────────────────────
// `base` is formatting forced onto every run (e.g. headings → bold + size,
// blockquotes → italic, table headers → bold).
function runsFromInline(tok, base) {
  base = base || {};
  const emit = (text, extra) => run(text, {
    b: base.b || (extra && extra.b),
    i: base.i || (extra && extra.i),
    strike: extra && extra.strike,
    link: extra && extra.link,
    code: extra && extra.code,
    sz: base.sz,
    font: base.font,
  });
  if (!tok) return '';
  if (!tok.children || !tok.children.length) return tok.content ? emit(tok.content, {}) : '';
  let out = '';
  let b = false, it = false, st = false, link = false;
  for (const c of tok.children) {
    switch (c.type) {
      case 'text': out += emit(c.content, { b, i: it, strike: st, link }); break;
      case 'strong_open': b = true; break;
      case 'strong_close': b = false; break;
      case 'em_open': it = true; break;
      case 'em_close': it = false; break;
      case 's_open': st = true; break;
      case 's_close': st = false; break;
      case 'code_inline': out += emit(c.content, { b, i: it, strike: st, code: true }); break;
      case 'softbreak': out += emit(' ', {}); break;
      case 'hardbreak': out += brRun(); break;
      case 'link_open': link = true; break;
      case 'link_close': link = false; break;
      case 'image': out += emit('[image: ' + (c.content || '') + ']', { i: true }); break;
      case 'html_inline': break; // drop raw HTML
      default: if (c.content) out += emit(c.content, { b, i: it, strike: st, link });
    }
  }
  return out;
}

// ── Tables ───────────────────────────────────────────────────────────
function renderTable(tokens, start) {
  const rows = [];
  let i = start + 1;
  let header = false;
  let cur = null;
  while (i < tokens.length && tokens[i].type !== 'table_close') {
    const t = tokens[i];
    if (t.type === 'thead_open') header = true;
    else if (t.type === 'thead_close') header = false;
    else if (t.type === 'tr_open') cur = { header, cells: [] };
    else if (t.type === 'tr_close') { if (cur) rows.push(cur); cur = null; }
    else if (t.type === 'th_open' || t.type === 'td_open') {
      const inline = tokens[i + 1];
      if (cur) cur.cells.push({ header, runs: runsFromInline(inline, header ? { b: true } : {}) });
      i += 2; // skip inline + close
    }
    i++;
  }
  const cols = rows.reduce((m, r) => Math.max(m, r.cells.length), 0) || 1;
  const w = Math.floor(9000 / cols);
  const borders =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`)
      .join('') +
    '</w:tblBorders>';
  const tblPr = `<w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>`;
  const grid = `<w:tblGrid>${Array(cols).fill(`<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  const rowsXml = rows
    .map((r) => {
      const cells = [];
      for (let c = 0; c < cols; c++) {
        const cell = r.cells[c];
        const runsXml = cell ? cell.runs : '';
        const shd = r.header ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : '';
        const tcPr = `<w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${shd}</w:tcPr>`;
        cells.push(`<w:tc>${tcPr}${para(runsXml, { after: 0 })}</w:tc>`);
      }
      return `<w:tr>${cells.join('')}</w:tr>`;
    })
    .join('');
  return [`<w:tbl>${tblPr}${grid}${rowsXml}</w:tbl>` + para('', { after: 0 }), i];
}

// ── Token stream → paragraphs ────────────────────────────────────────
function renderTokens(tokens) {
  const out = [];
  const listStack = []; // { ordered, counter }
  let pendingMarker = null;
  let quoteDepth = 0;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    switch (t.type) {
      case 'heading_open': {
        const lvl = parseInt(t.tag.slice(1), 10) || 1;
        const sz = HEADING_SZ[lvl] || 24;
        const runsXml = runsFromInline(tokens[i + 1], { b: true, sz });
        out.push(para(runsXml, { before: 240, after: 120 }));
        i += 3;
        break;
      }
      case 'paragraph_open': {
        if (listStack.length) {
          const runsXml = runsFromInline(tokens[i + 1]);
          const baseIndent = 360 * listStack.length;
          if (pendingMarker != null) {
            out.push(para(run(pendingMarker) + runsXml, { indentLeft: baseIndent + 360, hanging: 360, after: 60 }));
            pendingMarker = null;
          } else {
            out.push(para(runsXml, { indentLeft: baseIndent + 360, after: 60 }));
          }
        } else if (quoteDepth > 0) {
          const runsXml = runsFromInline(tokens[i + 1], { i: true });
          out.push(para(runsXml, { indentLeft: 360 * quoteDepth + 360, shd: 'F7F7F7' }));
        } else {
          out.push(para(runsFromInline(tokens[i + 1]), {}));
        }
        i += 3;
        break;
      }
      case 'bullet_list_open': listStack.push({ ordered: false, counter: 0 }); i++; break;
      case 'ordered_list_open': {
        const start = t.attrGet ? t.attrGet('start') : null;
        listStack.push({ ordered: true, counter: (start ? parseInt(start, 10) : 1) - 1 });
        i++; break;
      }
      case 'bullet_list_close':
      case 'ordered_list_close': listStack.pop(); i++; break;
      case 'list_item_open': {
        const top = listStack[listStack.length - 1];
        if (top) { top.counter++; pendingMarker = top.ordered ? `${top.counter}.\t` : '•\t'; }
        i++; break;
      }
      case 'list_item_close': pendingMarker = null; i++; break;
      case 'blockquote_open': quoteDepth++; i++; break;
      case 'blockquote_close': quoteDepth = Math.max(0, quoteDepth - 1); i++; break;
      case 'fence':
      case 'code_block': {
        const lines = String(t.content || '').replace(/\n$/, '').split('\n');
        for (const ln of lines) {
          out.push(para(run(ln || ' ', { code: true, sz: 18 }), { shd: 'F2F2F2', after: 0, before: 0 }));
        }
        out.push(para('', { after: 0 }));
        i++; break;
      }
      case 'hr': out.push(para('', { border: true })); i++; break;
      case 'table_open': { const [xml, ni] = renderTable(tokens, i); out.push(xml); i = ni + 1; break; }
      case 'html_block': i++; break;
      default: i++;
    }
  }
  return out.join('');
}

// ── Document assembly ────────────────────────────────────────────────
const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

function buildDocumentXml(body) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + body +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
    '</w:sectPr></w:body></w:document>'
  );
}

function convertMarkdownToDocx(markdown) {
  let body;
  try {
    body = renderTokens(md.parse(markdown || '', {}));
  } catch (_) {
    body = para(run(String(markdown || '')));
  }
  if (!body) body = para('');
  const documentXml = buildDocumentXml(body);
  return zipStore([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: 'word/document.xml', data: documentXml },
  ]);
}

// ── Minimal "stored" ZIP writer (no compression) ─────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const dataBuf = Buffer.from(f.data, 'utf8');
    const crc = crc32(dataBuf);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // compression: stored
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0x21, 12);        // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBuf.length, 18); // compressed size
    local.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra length
    chunks.push(local, nameBuf, dataBuf);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // central dir signature
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0, 8);              // flags
    cd.writeUInt16LE(0, 10);             // compression
    cd.writeUInt16LE(0, 12);             // mod time
    cd.writeUInt16LE(0x21, 14);          // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBuf.length, 20);
    cd.writeUInt32LE(dataBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);             // extra length
    cd.writeUInt16LE(0, 32);             // comment length
    cd.writeUInt16LE(0, 34);             // disk number start
    cd.writeUInt16LE(0, 36);             // internal attrs
    cd.writeUInt32LE(0, 38);             // external attrs
    cd.writeUInt32LE(offset, 42);        // local header offset
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + dataBuf.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central dir signature
  end.writeUInt16LE(0, 4);                // disk number
  end.writeUInt16LE(0, 6);                // central dir start disk
  end.writeUInt16LE(files.length, 8);     // entries this disk
  end.writeUInt16LE(files.length, 10);    // total entries
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);          // central dir offset
  end.writeUInt16LE(0, 20);               // comment length
  return Buffer.concat([...chunks, centralBuf, end]);
}

module.exports = { convertMarkdownToDocx };
