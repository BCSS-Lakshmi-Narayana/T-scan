import React, { useState, useCallback, useRef } from 'react';
import { uploadImage, analyzeImage } from './osintApi';

const ImageIntel = () => {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [uploadInfo, setUploadInfo] = useState(null);
  const [result, setResult] = useState(null);
  const [dragover, setDragover] = useState(false);
  const inputRef = useRef(null);

  const doUpload = useCallback(async (f) => {
    setFile(f); setError(''); setResult(null); setUploadInfo(null);
    setPreview(URL.createObjectURL(f));
    setIsUploading(true);
    try {
      const data = await uploadImage(f);
      if (data.error) throw new Error(data.error);
      setUploadInfo(data);
    } catch (err) { setError(err.message); }
    finally { setIsUploading(false); }
  }, []);

  const handleFileChange = (e) => { const f = e.target.files?.[0]; if (f) doUpload(f); };
  const handleDrop = (e) => { e.preventDefault(); setDragover(false); const f = e.dataTransfer.files?.[0]; if (f) doUpload(f); };

  const handleAnalyze = useCallback(async () => {
    if (!uploadInfo) return;
    setIsAnalyzing(true); setError('');
    try {
      const data = await analyzeImage();
      if (data.error) throw new Error(data.error);
      setResult(data.metadata || data);
    } catch (err) { setError(err.message); }
    finally { setIsAnalyzing(false); }
  }, [uploadInfo]);

  const clearAll = () => {
    setFile(null); setPreview(null); setUploadInfo(null); setResult(null); setError('');
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <main className="container my-4">
      {/* Upload Card */}
      <div className="upload-card">
        <div className="section-head">Image Intelligence & Metadata Analysis</div>

        <div className={`upload-zone ${dragover ? 'dragover' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragover(true); }}
          onDragLeave={() => setDragover(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          <input ref={inputRef} type="file" accept="image/*" onChange={handleFileChange} style={{ display: 'none' }} />
          <div className="upload-icon">📸</div>
          <div className="upload-text">Drop image here or click to upload</div>
          <div className="upload-hint">Supports JPG, PNG, TIFF, WebP, BMP, GIF — Max 50 MB</div>
        </div>

        {isUploading && (
          <div style={{ padding: '0 1.25rem 1rem' }}>
            <div className="progress"><div className="progress-bar progress-bar-striped progress-bar-animated bg-info" style={{ width: '70%' }} /></div>
            <p className="text-muted mt-1" style={{ fontSize: '.85rem' }}>Uploading...</p>
          </div>
        )}

        {/* Preview */}
        {preview && (
          <div className="preview-panel active">
            <div className="d-flex align-items-center gap-3">
              <img src={preview} alt="Preview" style={{ maxHeight: 120, borderRadius: 8, border: '1px solid #d3deef' }} />
              <div>
                <p style={{ fontWeight: 600, fontSize: '.9rem', marginBottom: '.2rem' }}>{file?.name}</p>
                <p className="text-muted" style={{ fontSize: '.82rem' }}>{uploadInfo?.size_formatted || `${((file?.size || 0) / 1024).toFixed(1)} KB`}</p>
              </div>
            </div>
          </div>
        )}

        {/* Action Panel */}
        {uploadInfo && (
          <div className="action-panel d-flex gap-2">
            <button className="btn-scan" onClick={handleAnalyze} disabled={isAnalyzing}>
              {isAnalyzing ? <><span className="spinner-border me-2" />Analyzing...</> : 'Extract Metadata'}
            </button>
            <button className="btn-clear" onClick={clearAll}>Clear</button>
          </div>
        )}
      </div>

      {error && <div className="alert alert-danger mt-3">{error}</div>}

      {/* Scanning Overlay */}
      {isAnalyzing && (
        <div className="scanning-overlay active">
          <div className="scanning-spinner" />
          <p style={{ color: '#fff', marginTop: '1.2rem', fontWeight: 600 }}>Extracting metadata...</p>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="mt-4">
          {/* Status */}
          {result.status && (
            <div className={`status-badge ${result.status.level || 'info'} mb-3`}>
              {result.status.text || 'Analysis Complete'}
            </div>
          )}
          {result.status?.description && <p className="text-muted mb-3" style={{ fontSize: '.85rem' }}>{result.status.description}</p>}

          <div className="row g-3">
            {/* GPS / Location */}
            <div className="col-lg-6">
              <div className="intel-card">
                <div className="intel-card-header"><span className="intel-card-title">Location Intelligence</span></div>
                <div className="intel-card-body">
                  {result.gps ? (
                    <>
                      <div className="gps-coordinates">
                        <div className="meta-label">GPS Coordinates</div>
                        <div className="coord-value">{result.gps.coordinates || `${result.gps.latitude}, ${result.gps.longitude}`}</div>
                      </div>
                      {result.gps.altitude && <div className="meta-item"><div className="meta-label">Altitude</div><div className="meta-value">{result.gps.altitude}</div></div>}
                      {result.gps.google_maps_url && (
                        <a href={result.gps.google_maps_url} target="_blank" rel="noopener noreferrer" className="maps-link mt-2">View on Google Maps &rarr;</a>
                      )}
                    </>
                  ) : <p className="text-muted" style={{ fontSize: '.88rem' }}>No GPS data embedded in this image.</p>}
                </div>
              </div>
            </div>

            {/* Device */}
            <div className="col-lg-6">
              <div className="intel-card">
                <div className="intel-card-header"><span className="intel-card-title">Device Intelligence</span></div>
                <div className="intel-card-body">
                  <div className="meta-item"><div className="meta-label">Make</div><div className="meta-value">{result.device?.make || '—'}</div></div>
                  <div className="meta-item"><div className="meta-label">Model</div><div className="meta-value highlight">{result.device?.model || '—'}</div></div>
                  <div className="meta-item"><div className="meta-label">Software</div><div className="meta-value">{result.device?.software || '—'}</div></div>
                  <div className="meta-item"><div className="meta-label">Lens</div><div className="meta-value">{result.device?.lens_info || '—'}</div></div>
                </div>
              </div>
            </div>

            {/* Timestamps */}
            <div className="col-lg-6">
              <div className="intel-card">
                <div className="intel-card-header"><span className="intel-card-title">Time Intelligence</span></div>
                <div className="intel-card-body">
                  <div className="meta-item"><div className="meta-label">Date Taken</div><div className="meta-value">{result.timestamps?.date_taken || '—'}</div></div>
                  <div className="meta-item"><div className="meta-label">Time</div><div className="meta-value">{result.timestamps?.time_taken || '—'}</div></div>
                  <div className="meta-item"><div className="meta-label">Timezone</div><div className="meta-value">{result.timestamps?.timezone || '—'}</div></div>
                  <div className="meta-item"><div className="meta-label">Modified</div><div className="meta-value">{result.timestamps?.date_modified || '—'}</div></div>
                </div>
              </div>
            </div>

            {/* File Info */}
            <div className="col-lg-6">
              <div className="intel-card">
                <div className="intel-card-header"><span className="intel-card-title">File Intelligence</span></div>
                <div className="intel-card-body">
                  <div className="meta-item"><div className="meta-label">Filename</div><div className="meta-value" style={{ fontFamily: 'monospace', fontSize: '.82rem' }}>{result.file?.filename || file?.name || '—'}</div></div>
                  <div className="meta-item"><div className="meta-label">Format</div><div className="meta-value">{result.file?.format || '—'}</div></div>
                  <div className="meta-item"><div className="meta-label">MIME Type</div><div className="meta-value">{result.file?.mime_type || '—'}</div></div>
                  <div className="meta-item"><div className="meta-label">Size</div><div className="meta-value">{result.file?.file_size || '—'}</div></div>
                  <div className="meta-item"><div className="meta-label">Resolution</div><div className="meta-value">{result.file?.resolution || '—'}</div></div>
                </div>
              </div>
            </div>
          </div>

          {/* Warnings */}
          {result.warnings && result.warnings.length > 0 && (
            <div className="notice-callout mt-3">
              <strong>Warnings:</strong>
              <ul style={{ margin: '.4rem 0 0', paddingLeft: '1.2rem' }}>
                {result.warnings.map((w, i) => <li key={i} style={{ fontSize: '.85rem' }}>{w}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </main>
  );
};

export default ImageIntel;
