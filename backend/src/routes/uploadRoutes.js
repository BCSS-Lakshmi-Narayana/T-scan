const express = require('express');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

console.log('📦 UPLOAD ROUTES LOADED - VERSION: ONPREM-DISK-V1 (tenant-scoped)');

const router = express.Router();
router.use(protect, requireAnyPageAccess(['/dial-100-incident-reporting', '/grievances', '/person-of-interest']));

// ─── On-prem, tenant-isolated local storage (replaces AWS S3) ──────────────
// User-uploaded evidence/documents live under storage/<tenant_id>/uploads/...
// The public URL is RELATIVE (no tenant id) — the /files route serves each
// tenant its own folder based on the request subdomain, so a URL is meaningless
// outside its own tenant and one tenant can never read another's files.
const STORAGE_DIR = process.env.FILE_STORAGE_DIR || path.join(__dirname, '..', '..', 'storage');
const UPLOAD_FOLDER = process.env.UPLOAD_FOLDER || 'uploads';
const safeTenant = (t) => (String(t || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

const buildPublicUrl = (key) =>
  `/files/${String(key).split('/').map(encodeURIComponent).join('/')}`;

// Path-traversal guard: the resolved path must stay inside the tenant's dir.
const absPathFor = (tenantId, key) => {
  const tenantRoot = path.join(STORAGE_DIR, safeTenant(tenantId));
  const abs = path.join(tenantRoot, key);
  if (!path.resolve(abs).startsWith(path.resolve(tenantRoot))) {
    throw new Error('Invalid storage key (path traversal blocked)');
  }
  return abs;
};

const writeBufferToDisk = async (file, tenantId, customKey = null) => {
  if (!file.buffer || file.size === 0) {
    throw new Error('Cannot write empty file to storage');
  }
  const key = customKey || `${UPLOAD_FOLDER}/${crypto.randomUUID()}-${file.originalname.replace(/\s+/g, '-')}`;
  const absPath = absPathFor(tenantId, key);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  await fs.promises.writeFile(absPath, file.buffer);

  const resourceType = file.mimetype?.startsWith('image/') ? 'image'
    : file.mimetype?.startsWith('video/') ? 'video' : 'file';

  return {
    url: buildPublicUrl(key),
    key,
    resource_type: resourceType,
    original_filename: file.originalname
  };
};

// POST /api/uploads/s3  — path kept for frontend compatibility; now writes to disk.
router.post('/s3', upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded' });
    }

    let customKey = req.query.customKey || req.headers['x-s3-key'] || req.body.customKey;
    if (customKey === 'undefined' || customKey === 'null') customKey = null;

    const uploads = await Promise.all(
      req.files.map(file => writeBufferToDisk(file, req.tenantId, customKey))
    );

    res.status(200).json({ uploads });
  } catch (error) {
    console.error('[Upload] ❌ Disk write failed:', error.message);
    res.status(500).json({ message: 'Upload failed', error: error.message });
  }
});

// GET /api/uploads/predict — Pre-calculate the URL + key (single source of truth).
router.get('/predict', (req, res) => {
  try {
    const { filename } = req.query;
    if (!filename) return res.status(400).json({ message: 'Filename is required' });

    const uuid = crypto.randomUUID();
    const cleanFileName = filename.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9-_.]/g, '');
    const key = `${UPLOAD_FOLDER}/${uuid}-${cleanFileName}`;

    res.json({ url: buildPublicUrl(key), key });
  } catch (error) {
    console.error('[Upload Predict] Error:', error);
    res.status(500).json({ message: 'Prediction failed', error: error.message });
  }
});

// Proxy endpoint for downloading external files to bypass CORS.
router.get('/proxy', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL is required');

    const response = await axios({ method: 'GET', url, responseType: 'stream' });
    const contentType = response.headers['content-type'];
    let filename = url.split('/').pop().split('?')[0];
    if (!filename) filename = 'downloaded-file';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.data.pipe(res);
  } catch (error) {
    console.error('Proxy download error:', error);
    res.status(500).send('Failed to download file');
  }
});

module.exports = router;
