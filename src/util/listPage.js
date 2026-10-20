'use strict';

// Opt-in contract: legacy callers retain their array response.
function listPage(body = {}, defaultSize = 10) {
    if (body.page === undefined && body.page_size === undefined) return null;
    const integer = (value, fallback, max) => {
        if (value === undefined) return fallback;
        if (!['number', 'string'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value))) throw new Error('INVALID_LIST_PAGE');
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed > max) throw new Error('INVALID_LIST_PAGE');
        return parsed;
    };
    return { page: integer(body.page, 1, 1000000), pageSize: integer(body.page_size, defaultSize, 50) };
}
function pageWindow(request, total) {
    const totalPages = Math.max(1, Math.ceil(Number(total) / request.pageSize));
    const page = Math.min(request.page, totalPages);
    return { page, pageSize: request.pageSize, total: Number(total), totalPages, offset: (page - 1) * request.pageSize };
}
function pageData(items, pagination) {
    const { offset, ...metadata } = pagination;
    return { items, pagination: metadata };
}
module.exports = { listPage, pageWindow, pageData };
