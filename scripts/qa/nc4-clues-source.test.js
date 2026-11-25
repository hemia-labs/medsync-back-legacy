'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getCluesSource, selectCluesSource } = require('../../src/domain/sisCatalog/cluesSource');

const portal = 'https://gobi.salud.gob.mx/';
const file = 'gobi/guias/sis/catalogos/ESTABLECIMIENTO_DE_SALUD_SIS_202610.xlsx?v=2026.11.20';
const old = file.replace('202610', '202609');
const master = 'gobi/catalogos/catalogosmaestros/ESTABLECIMIENTO_SALUD_202610.xlsx';
const link = url => '<a href="' + url + '">Descargar</a>';
const section = (period, links) => '<div class="card-header bg_black text-white"><i></i> Gu&iacute;as SIS ' +
    period + '</div><div class="list-group">' + links.map(link).join('') + '</div>';
const current = links => section('2026 (Vigente)', links);
const page = section('2024 (Fe de erratas)', [old]) + current([master, file]) + section('2022 (No vigente)', [old]);

test('resuelve solo el archivo de la sección vigente aun si el enlace viejo aparece primero', () => {
    assert.deepEqual(selectCluesSource(page), { sourceUrl: portal + file, sourceVersion: '202610' });
    assert.equal(selectCluesSource(current([file, file])).sourceVersion, '202610');
});

test('exige una sección y un archivo inequívocos sin recurrir al maestro ni al histórico', () => {
    for (const markup of [section('2024 (No vigente)', [old]), current([master]), current([old, file]),
        page + current([file]), '<!--' + current([file]) + '-->']) {
        assert.throws(() => selectCluesSource(markup), /GOBI/);
    }
    for (const base of ['http://gobi.salud.gob.mx/', 'https://example.com/', 'https://usuario@gobi.salud.gob.mx/']) {
        assert.throws(() => selectCluesSource(current([base + file])), /origen/);
    }
});

test('descarga el archivo publicado con límite de tiempo y sin seguir redirecciones', async () => {
    const sample = Buffer.from([80, 75, 3, 4, 1]);
    const calls = [];
    const result = await getCluesSource(async (url, options) => {
        calls.push(url);
        assert.equal(options.redirect, 'manual');
        assert.ok(options.signal instanceof AbortSignal);
        return new Response(url === portal ? page : sample);
    });
    assert.deepEqual(calls, [portal, portal + file]);
    assert.deepEqual(result, { sourceUrl: portal + file, sourceVersion: '202610', buffer: sample });
});

test('rechaza página de error, respuesta parcial y descarga mayor al límite anunciado o transmitido', async () => {
    for (const [response, code] of [[new Response('<html>error</html>'), 'CLUES_SOURCE_NOT_XLSX'],
        [new Response('parcial', { status: 206 }), 'CLUES_SOURCE_HTTP'],
        [new Response(null, { status: 302, headers: { location: 'https://example.com/' } }), 'CLUES_SOURCE_HTTP'],
        [new Response('x', { headers: { 'content-length': '20000000' } }), 'CLUES_SOURCE_SIZE'],
        [new Response(Buffer.alloc(16 * 1024 * 1024 + 1)), 'CLUES_SOURCE_SIZE']]) {
        await assert.rejects(getCluesSource(url => url === portal ? new Response(page) : response),
            { code, check: { sourceUrl: portal + file, sourceVersion: '202610' } });
    }
});

test('red, tiempo de espera, lectura interrumpida y HTTP transitorio se pueden reintentar', async () => {
    const interrupted = () => new Response(new ReadableStream({ start(stream) { stream.error(new Error('desconectado')); } }));
    for (const failure of [() => { throw new TypeError('fetch failed'); },
        () => { throw new DOMException('timeout', 'TimeoutError'); }, interrupted,
        () => new Response(null, { status: 503 }), () => new Response(null, { status: 429 }),
        () => new Response(null, { status: 408 })]) {
        await assert.rejects(getCluesSource(url => url === portal ? new Response(page) : failure()), {
            code: 'CLUES_SOURCE_UNAVAILABLE', check: { sourceUrl: portal + file, sourceVersion: '202610' }
        });
    }
    await assert.rejects(getCluesSource(() => new Response('<html></html>')), { code: 'CLUES_SOURCE_SECTION' });
    await assert.rejects(getCluesSource(() => new Response(current([master]))), { code: 'CLUES_SOURCE_LINK' });
});
