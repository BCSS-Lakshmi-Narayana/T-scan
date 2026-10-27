/**
 * periscopeS3Service.js
 * ---------------------
 * Stores generated Periscope DOCX files on the on-prem server disk (replaces
 * AWS S3) under storage/<tenant_id>/periscope-documents/... and returns a
 * server-relative download URL. The /files route serves each tenant only its
 * own folder (tenant resolved from the request subdomain).
 */

const fs = require('fs');
const path = require('path');

const STORAGE_DIR = process.env.FILE_STORAGE_DIR || path.join(__dirname, '..', '..', 'storage');
const safeTenant = (t) => (String(t || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown');

const PERISCOPE_FOLDER = 'periscope-documents';

/**
 * Write a DOCX buffer to on-prem storage (tenant-scoped).
 * Key format: periscope-documents/2026-02-07/Periscope_for_the_day_07.02.2026.docx
 *
 * @param {Buffer} buffer - File buffer
 * @param {string} dateStr - Date string YYYY-MM-DD
 * @param {string} originalFilename - Original file name
 * @param {string} tenantId - owning tenant
 * @returns {{ url: string, key: string }}
 */
const uploadPeriscopeToS3 = async (buffer, dateStr, originalFilename, tenantId = null) => {
    const safeName = String(originalFilename || 'periscope.docx').replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${PERISCOPE_FOLDER}/${dateStr}/${safeName}`;

    const absPath = path.join(STORAGE_DIR, safeTenant(tenantId), key);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, buffer);

    const url = `/files/${key.split('/').map(encodeURIComponent).join('/')}`;
    return { url, key };
};

/**
 * Build the server-relative download URL for a stored DOCX. No presigning is
 * needed on-prem — the /files route serves it (tenant-scoped by subdomain).
 *
 * @param {string} s3Key - The stored object key
 * @returns {string} relative download URL
 */
const getPeriscopeDownloadUrl = async (s3Key) => {
    return `/files/${String(s3Key).split('/').map(encodeURIComponent).join('/')}`;
};

module.exports = {
    uploadPeriscopeToS3,
    getPeriscopeDownloadUrl,
};
