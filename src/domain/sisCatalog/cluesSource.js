'use strict';

const PORTAL = 'https://gobi.salud.gob.mx/';
const CLUES_PATH = /^\/gobi\/guias\/sis\/catalogos\/ESTABLECIMIENTO_DE_SALUD_SIS_(\d{4}(?:0[1-9]|1[0-2]))\.xlsx$/;

function sourceError(code, message) {
    return Object.assign(new Error('GOBI: ' + message), { code });
}

function selectCluesSource(markup) {
    // GOBI publica en una misma portada la guía vigente, fe de erratas y guías anteriores.
    const html = markup.replace(/<!--[\s\S]*?-->/g, '');
    const headers = [...html.matchAll(/<div\b[^>]*\sclass\s*=\s*(["'])[^"']*\bcard-header\b[^"']*\1[^>]*>([\s\S]*?)<\/div\s*>/gi)];
    const sections = headers.flatMap((header, index) => {
        const title = header[2].replace(/<[^>]+>/g, ' ').replace(/&iacute;|&#237;|&#xed;/gi, 'í')
            .replace(/\s+/g, ' ').trim();
        return /^gu[íi]as SIS \d{4} \(vigente\)$/i.test(title)
            ? [html.slice(header.index + header[0].length, headers[index + 1]?.index)] : [];
    });
    if (sections.length !== 1) throw sourceError('CLUES_SOURCE_SECTION', 'no se identificó una única sección SIS vigente.');

    const sources = new Map();
    for (const link of sections[0].matchAll(/<a\b[^>]*?\shref\s*=\s*(["'])([^"']+)\1/gi)) {
        const url = URL.parse(link[2].replace(/&amp;/gi, '&'), PORTAL);
        if (!url) throw sourceError('CLUES_SOURCE_LINK', 'URL inválida en la sección SIS vigente.');
        const match = CLUES_PATH.exec(url.pathname);
        if (!match) continue;
        if (url.origin !== new URL(PORTAL).origin || url.username || url.password || url.hash) {
            throw sourceError('CLUES_SOURCE_LINK', 'origen de descarga de CLUES no permitido.');
        }
        sources.set(url.href, { sourceUrl: url.href, sourceVersion: match[1] });
    }
    if (sources.size !== 1) throw sourceError('CLUES_SOURCE_LINK', 'falta un enlace único al archivo CLUES SIS vigente.');
    return [...sources.values()][0];
}

async function download(url, limit, fetchImpl) {
    let response;
    try {
        response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
        const { status } = response;
        if (status !== 200) {
            const transient = status === 408 || status === 429 || status >= 500;
            throw sourceError(transient ? 'CLUES_SOURCE_UNAVAILABLE' : 'CLUES_SOURCE_HTTP', 'respuesta HTTP ' + status + '.');
        }
        if (!response.body) throw sourceError('CLUES_SOURCE_EMPTY', 'respuesta sin contenido.');
        if (Number(response.headers.get('content-length')) > limit) {
            throw sourceError('CLUES_SOURCE_SIZE', 'la descarga anunciada excede el tamaño permitido.');
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > limit) throw sourceError('CLUES_SOURCE_SIZE', 'la descarga excede el tamaño permitido.');
            chunks.push(chunk);
        }
        return Buffer.concat(chunks, size);
    } catch (error) {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
        if (String(error?.code).startsWith('CLUES_SOURCE_')) throw error;
        throw sourceError('CLUES_SOURCE_UNAVAILABLE', 'la conexión o la lectura de la descarga se interrumpió.');
    }
}

async function getCluesSource(fetchImpl = fetch) {
    const index = await download(PORTAL, 2 * 1024 * 1024, fetchImpl);
    const source = selectCluesSource(index.toString('utf8'));
    try {
        const buffer = await download(source.sourceUrl, 16 * 1024 * 1024, fetchImpl);
        if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
            throw sourceError('CLUES_SOURCE_NOT_XLSX', 'se esperaba un archivo XLSX.');
        }
        return { ...source, buffer };
    } catch (error) {
        error.check = source;
        throw error;
    }
}

module.exports = { getCluesSource, selectCluesSource };
