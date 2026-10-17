// Pure HTML policy regression. No database, browser, network or messages.
const assert = require('node:assert/strict');
const { parseDocument } = require('htmlparser2');
const { sanitizeDocumentHtml, sanitizeDocumentRichText, renderDocumentTemplate, safeDocumentForDisplay } = require('../../src/services/documentSignature/documentHtml.service');

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=';
const injection = '<img src=x onerror="fetch(\'/api/private\')">';
assert.equal(renderDocumentTemplate('<p>Paciente: {{nombrePaciente}}</p>', { nombrePaciente: injection }),
    '<p>Paciente: &lt;img src=x onerror="fetch(\'/api/private\')"&gt;</p>', 'Patient data must remain literal visible text');
assert.equal(renderDocumentTemplate('<p>{{edadPaciente}} / {{missing}} / {{toString}}</p>', { edadPaciente: 0 }), '<p>0 /  / </p>');
assert.equal(renderDocumentTemplate('<p title="{{name}}">{{name}}</p>', { name: 'Ana " onmouseover="attack() & Juárez' }),
    '<p title="Ana &quot; onmouseover=&quot;attack() &amp; Juárez">Ana " onmouseover="attack() &amp; Juárez</p>');
const badContext = renderDocumentTemplate('<a href="{{url}}">Contacto</a><p style="color:{{color}}">Texto</p>',
    { url: 'javascript:alert(1)', color: 'expression(alert(1))' });
assert.equal(badContext, '<a rel="noopener noreferrer">Contacto</a><p>Texto</p>', 'Escaping alone does not protect URL/CSS contexts');

const unsafe = [
    '<script>attack()</script><p onclick="attack()">Clinical text</p>',
    '<style>body{display:none}</style><p style="position:fixed;z-index:99999;background-image:url(https://attacker.invalid);color:#123456">Clinical text</p>',
    '<iframe srcdoc="<script>attack()</script>"></iframe><object data="javascript:attack()"></object><p>Clinical text</p>',
    '<svg onload="attack()"><foreignObject><p onclick="attack()">Clinical text</p></foreignObject></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=attack()>"></table></mtext></math>',
    '<form action="/api/danger"><input name="patient" autofocus onfocus="attack()"></form><p>Clinical text</p>',
    '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImF0dGFjaygpIj4=" onerror="attack()">',
    '<a href="java&#x73;cript:attack()" target="_blank">Clinical text</a>',
    '<a href="javascript\t:attack()">Clinical text</a>',
    '<img src="//attacker.invalid/tracker" srcset="x 1x" onerror="attack()">',
    '<p id="app" name="location" class="fixed inset-0" style="margin:-100px;color:expression(attack());font-family:url(https://attacker.invalid)">Clinical text</p>'
];
for (const payload of unsafe) {
    const clean = sanitizeDocumentHtml(payload);
    const inspect = node => {
        assert.ok(!['script', 'style', 'iframe', 'object', 'svg', 'math', 'form', 'input'].includes(node.name), clean);
        for (const [name, value] of Object.entries(node.attribs || {})) {
            assert.doesNotMatch(name, /^(?:on\w+|id|name|class|srcset|target)$/i, clean);
            if (['href', 'src'].includes(name)) assert.doesNotMatch(value, /^javascript\s*:|^data:image\/svg/i, clean);
            if (name === 'style') assert.doesNotMatch(value, /(?:position|z-index|background-image|expression)\s*[:(]/i, clean);
        }
        (node.children || []).forEach(inspect);
    };
    inspect(parseDocument(clean));
    assert.equal(sanitizeDocumentHtml(clean), clean, 'Re-sanitizing must be stable');
}

const rich = `<section><h2>Consentimiento</h2><p style="font-family:'Times New Roman', serif;font-size:12pt;text-align:justify;line-height:1.5;margin-bottom:12pt">María &amp; José, <strong>atención</strong> y <em>firma</em>.</p><table style="width:100%;border-collapse:collapse"><thead><tr><th scope="col" colspan="2" style="border:1px solid #333">Tratamiento</th></tr></thead><tbody><tr><td>Revisión</td><td>2 sesiones</td></tr></tbody></table><ol start="2"><li>Información</li></ol><img src="${png}" alt="Firma" width="120" height="60"><a href="https://example.invalid/consent">Información</a><p style="page-break-before:always">Continuación</p></section>`;
const cleanRich = sanitizeDocumentHtml(rich);
assert.match(cleanRich, /<table style="width:100%;border-collapse:collapse">/);
assert.match(cleanRich, /<th scope="col" colspan="2" style="border:1px solid #333">/);
assert.match(cleanRich, /font-family:'Times New Roman', serif;font-size:12pt;text-align:justify;line-height:1.5;margin-bottom:12pt/);
assert.ok(cleanRich.includes(png), 'Raster signatures must survive');
assert.match(cleanRich, /<ol start="2"><li>Información<\/li><\/ol>/);
assert.match(cleanRich, /page-break-before:always/);
assert.match(cleanRich, /María &amp; José/);
assert.equal(sanitizeDocumentHtml(cleanRich), cleanRich);
assert.equal(sanitizeDocumentHtml('<p>Paciente {{nombrePaciente}}, edad {{edadPaciente}}</p>'), '<p>Paciente {{nombrePaciente}}, edad {{edadPaciente}}</p>');

const signed = Object.freeze({ status: 'FIRMADO', content_html_snapshot: unsafe[0], signed_content_html_snapshot: unsafe[0], doctor_signature_snapshot: png, hash: 'historical-hash' });
const delivered = safeDocumentForDisplay(signed);
assert.equal(delivered.content_html_snapshot, '<p>Clinical text</p>');
assert.equal(delivered.signed_content_html_snapshot, '<p>Clinical text</p>');
assert.equal(signed.signed_content_html_snapshot, unsafe[0], 'Historical source must remain unchanged');
assert.equal(delivered.doctor_signature_snapshot, png);
assert.equal(delivered.hash, signed.hash);
assert.equal(safeDocumentForDisplay({ signed_content_html_snapshot: null }).signed_content_html_snapshot, null);
assert.equal(sanitizeDocumentRichText('Información & revisión\nMenor de 10'), 'Información & revisión\nMenor de 10');
assert.equal(sanitizeDocumentRichText('<p>Información</p><script>attack()</script>'), '<p>Información</p>');
console.log('PASS document HTML policy: literal interpolation, dangerous URL/CSS contexts, active-content/malformed HTML fixtures, safe rich layout/raster signatures, stable sanitization and immutable historical snapshots. No DB or network.');
