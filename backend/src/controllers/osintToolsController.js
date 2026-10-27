const buildDefaultOsintUrl = (req) => {
  const explicitUrl = process.env.OSINT_TOOLS_URL;
  if (explicitUrl) return explicitUrl;

  const protocol = req.protocol || 'http';
  const host = req.get('host') || req.hostname || 'localhost';

  return `${protocol}://${host}/osint/`;
};

const getOsintToolsConfig = async (req, res) => {
  try {
    res.status(200).json({
      url: buildDefaultOsintUrl(req)
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to resolve OSINT tools configuration' });
  }
};

module.exports = {
  getOsintToolsConfig
};
