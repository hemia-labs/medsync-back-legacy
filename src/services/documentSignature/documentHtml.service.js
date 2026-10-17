const sanitizeHtml = require('sanitize-html');

// Clinical documents are rich text, never executable pages. Keep the same
// policy at generation and at delivery, including legacy signed snapshots.
const length = '(?:0|\\d+(?:\\.\\d+)?(?:px|pt|pc|cm|mm|in|em|rem|%))';
const spacing = new RegExp(`^(?:${length}|auto)(?:\\s+(?:${length}|auto)){0,3}$`, 'i');
const color = /^(?:#[0-9a-f]{3,8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\([\d\s.,%]+\))$/i;
const styles = {
    color: [color], 'background-color': [color],
    'font-family': [/^[\w\s,"'-]+$/],
    'font-size': [new RegExp(`^(?:${length}|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$`, 'i')],
    'font-weight': [/^(?:normal|bold|bolder|lighter|[1-9]00)$/i],
    'font-style': [/^(?:normal|italic|oblique)$/i],
    'text-align': [/^(?:left|right|center|justify|start|end)$/i],
    'text-decoration': [/^(?:none|underline|overline|line-through)(?:\s+(?:underline|overline|line-through))*$/i],
    'text-transform': [/^(?:none|capitalize|uppercase|lowercase)$/i],
    'line-height': [new RegExp(`^(?:normal|\\d+(?:\\.\\d+)?|${length})$`, 'i')],
    'white-space': [/^(?:normal|pre|pre-wrap|pre-line|break-spaces)$/i],
    'word-break': [/^(?:normal|break-all|keep-all|break-word)$/i],
    'overflow-wrap': [/^(?:normal|break-word|anywhere)$/i],
    'vertical-align': [/^(?:baseline|sub|super|top|text-top|middle|bottom|text-bottom)$/i],
    'border-collapse': [/^(?:collapse|separate)$/i],
    'border-spacing': [spacing], 'table-layout': [/^(?:auto|fixed)$/i],
    'page-break-before': [/^(?:auto|always|avoid|left|right)$/i],
    'page-break-after': [/^(?:auto|always|avoid|left|right)$/i],
    'page-break-inside': [/^(?:auto|avoid)$/i],
    'break-inside': [/^(?:auto|avoid|avoid-page)$/i]
};
for (const property of ['margin', 'padding', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'text-indent',
    'width', 'max-width', 'min-width', 'height', 'max-height', 'min-height']) styles[property] = [spacing];
for (const property of ['border', 'border-top', 'border-right', 'border-bottom', 'border-left']) {
    styles[property] = [/^(?:none|0|(?:\d+(?:\.\d+)?(?:px|pt|em|rem)\s+)?(?:solid|dashed|dotted|double)\s+(?:#[0-9a-f]{3,8}|[a-z]+))$/i];
    styles[`${property}-width`] = [spacing];
    styles[`${property}-style`] = [/^(?:none|solid|dashed|dotted|double)$/i];
    styles[`${property}-color`] = [color];
}

function safeImageSource(value) {
    const source = String(value || '').trim();
    if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i.test(source)) return source;
    if (/^https?:\/\/[^\s<>"'\\]+$/i.test(source)) return source;
    if (/^(?:\/(?!\/)|\.\.?\/)[^\s<>"'\\]*$/.test(source)) return source;
    return '';
}

function sanitizeDocumentHtml(value) {
    return sanitizeHtml(String(value == null ? '' : value), {
        allowedTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'span', 'section', 'article',
            'header', 'footer', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'sub', 'sup', 'small',
            'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'caption',
            'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col', 'a', 'img', 'figure', 'figcaption'],
        allowedAttributes: {
            '*': ['style', 'title', 'lang', 'dir'],
            a: ['href', 'rel'], img: ['src', 'alt', 'width', 'height'],
            table: ['width', 'border', 'cellpadding', 'cellspacing', 'align'],
            th: ['colspan', 'rowspan', 'scope', 'width', 'height', 'align', 'valign'],
            td: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign'],
            tr: ['align', 'valign'], col: ['span', 'width'], colgroup: ['span', 'width'],
            ol: ['start', 'type', 'reversed'], li: ['value']
        },
        allowedStyles: { '*': styles },
        allowedSchemes: ['http', 'https', 'mailto', 'tel'],
        allowedSchemesByTag: { img: ['http', 'https', 'data'] },
        allowProtocolRelative: false,
        nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'noscript'],
        transformTags: {
            img: (tagName, attributes) => {
                const attribs = { ...attributes };
                const source = safeImageSource(attribs.src);
                if (source) attribs.src = source; else delete attribs.src;
                return { tagName, attribs };
            },
            a: (tagName, attributes) => ({ tagName, attribs: { ...attributes, rel: 'noopener noreferrer' } })
        }
    });
}

function escapeDocumentText(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g,
        character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function renderDocumentTemplate(html, context = {}) {
    // Escape text first; the final sanitizer also rejects dangerous attribute
    // contexts (e.g. a variable containing a javascript: link or CSS value).
    return sanitizeDocumentHtml(String(html || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
        (_match, key) => escapeDocumentText(Object.prototype.hasOwnProperty.call(context, key) ? context[key] : '')));
}

function safeDocumentForDisplay(document) {
    const result = { ...document };
    for (const field of ['content_html', 'content_html_snapshot', 'signed_content_html_snapshot']) {
        if (result[field] != null) result[field] = sanitizeDocumentHtml(result[field]);
    }
    // Do not mutate persisted content or cryptographic/signature metadata.
    return result;
}

function sanitizeDocumentRichText(value) {
    // Legacy treatment consent fields can contain either plain text or HTML.
    // Preserve the plain-text contract so clients do not double-escape it.
    if (value == null) return value;
    const text = String(value);
    return /<[^>]+>/.test(text) ? sanitizeDocumentHtml(text) : text;
}

module.exports = { sanitizeDocumentHtml, sanitizeDocumentRichText, escapeDocumentText, renderDocumentTemplate, safeDocumentForDisplay };
