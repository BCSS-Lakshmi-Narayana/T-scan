const express = require('express');
const router = express.Router();
const { register, login, logout, refreshToken, getMe, forgotPassword, resetPassword, verifyResetToken } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', register);
router.post('/login', login);
router.post('/logout', protect, logout);
router.post('/refresh', refreshToken);
router.get('/me', protect, getMe);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);
router.get('/reset-password/:token/verify', verifyResetToken);

module.exports = router;
