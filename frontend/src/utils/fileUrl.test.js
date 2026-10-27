jest.mock('../lib/api', () => ({ BACKEND_URL: 'http://backend.test:8001' }));

const { resolveFileUrl } = require('./fileUrl');

describe('resolveFileUrl', () => {
  it('re-points a stale absolute /files URL at this build backend', () => {
    expect(resolveFileUrl('http://localhost:8001/files/grievance-reports/ABC-1.pdf'))
      .toBe('http://backend.test:8001/api/files/grievance-reports/ABC-1.pdf');
  });

  it('rewrites a proxied /api/files URL to the same place', () => {
    expect(resolveFileUrl('https://police.example.com/api/files/grievance-reports/ABC-1.pdf'))
      .toBe('http://backend.test:8001/api/files/grievance-reports/ABC-1.pdf');
  });

  it('handles a relative path', () => {
    expect(resolveFileUrl('/files/grievance-reports/ABC-1.pdf'))
      .toBe('http://backend.test:8001/api/files/grievance-reports/ABC-1.pdf');
  });

  it('keeps encoded segments intact', () => {
    expect(resolveFileUrl('http://localhost:8001/files/grievance-reports/A%20B-1.pdf'))
      .toBe('http://backend.test:8001/api/files/grievance-reports/A%20B-1.pdf');
  });

  it('leaves off-site links alone', () => {
    const post = 'https://x.com/TelanganaDGP/status/123';
    expect(resolveFileUrl(post)).toBe(post);
  });

  it('returns an empty string for missing values', () => {
    expect(resolveFileUrl(null)).toBe('');
    expect(resolveFileUrl(undefined)).toBe('');
    expect(resolveFileUrl('   ')).toBe('');
  });
});
