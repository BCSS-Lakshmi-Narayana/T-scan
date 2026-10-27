const { createProxyMiddleware } = require('http-proxy-middleware');

const RAG_TARGET = process.env.REACT_APP_RAG_PROXY_TARGET || 'http://localhost:8100';

module.exports = function(app) {
  app.use(
    '/osint',
    createProxyMiddleware({
      target: RAG_TARGET,
      changeOrigin: true,
    })
  );
  app.use(
    '/api/rag',
    createProxyMiddleware({
      target: RAG_TARGET,
      changeOrigin: true,
    })
  );
};
