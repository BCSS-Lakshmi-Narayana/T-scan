const express = require('express');
const router = express.Router();
const axios = require('axios');

router.get('/search', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const serviceUrl = process.env.MAIGRET_SERVICE_URL;
    if (!serviceUrl) {
      return res.status(500).json({ error: 'Maigret service URL not configured' });
    }

    const response = await axios.get(`${serviceUrl}/search`, { params: { username } });
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Maigret data:', error.message);
    res.status(error.response?.status || 500).json({ error: 'Failed to fetch Maigret data', details: error.message });
  }
});

module.exports = router;
