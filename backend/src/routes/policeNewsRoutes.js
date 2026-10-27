const express = require('express');
const router  = express.Router();
const {
  getArticles, clearAll, deleteArticle,
  getKeywords, addKeyword, toggleKeyword, deleteKeyword,
} = require('../controllers/policeNewsController');
const { protect } = require('../middleware/authMiddleware');

// keyword routes must come before /:id
router.get   ('/keywords',     protect, getKeywords);
router.post  ('/keywords',     protect, addKeyword);
router.patch ('/keywords/:id', protect, toggleKeyword);
router.delete('/keywords/:id', protect, deleteKeyword);

router.delete('/clear-all',    protect, clearAll);
router.get   ('/',             protect, getArticles);
router.delete('/:id',          protect, deleteArticle);

module.exports = router;
