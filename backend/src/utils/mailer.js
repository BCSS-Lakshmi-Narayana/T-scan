const nodemailer = require('nodemailer');

/**
 * Create a reusable SMTP transporter from environment variables.
 */
const createTransporter = () => {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
};

/**
 * Send a password-reset email with a tokenised link.
 *
 * @param {string} toEmail  – recipient address
 * @param {string} resetUrl – full URL the user clicks to reset
 * @param {string} userName – display name for greeting
 */
const sendPasswordResetEmail = async (toEmail, resetUrl, userName) => {
  const transporter = createTransporter();
  if (!transporter) {
    console.error('[SMTP] Not configured — cannot send password reset email');
    return false;
  }

  const fromName = process.env.SMTP_FROM_NAME || 'SOC-EYE';
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
    body { margin:0; padding:0; font-family: Arial, Helvetica, sans-serif; background:#f4f5f7; }
    .wrap { max-width:520px; margin:40px auto; background:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,0.08); }
    .header { background:linear-gradient(135deg,#1e3a5f 0%,#1e40af 100%); padding:28px 32px; text-align:center; }
    .header h1 { color:#ffffff; margin:0; font-size:22px; letter-spacing:1px; }
    .header p { color:#93c5fd; margin:6px 0 0; font-size:11px; text-transform:uppercase; letter-spacing:2px; }
    .body { padding:32px; color:#334155; line-height:1.7; font-size:14px; }
    .btn { display:inline-block; background:linear-gradient(135deg,#f59e0b,#d97706); color:#1e293b; font-weight:bold; text-decoration:none; padding:12px 32px; border-radius:8px; font-size:14px; margin:20px 0; }
    .footer { padding:20px 32px; background:#f8fafc; text-align:center; font-size:11px; color:#94a3b8; }
    .code { background:#f1f5f9; padding:2px 8px; border-radius:4px; font-family:monospace; font-size:13px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <h1>SOC - EYE</h1>
      <p>Password Reset Request</p>
    </div>
    <div class="body">
      <p>Hello <strong>${userName || 'User'}</strong>,</p>
      <p>We received a request to reset the password for your account. Click the button below to set a new password:</p>
      <p style="text-align:center;">
        <a href="${resetUrl}" class="btn">Reset My Password</a>
      </p>
      <p style="font-size:12px; color:#64748b;">
        If the button doesn't work, copy and paste this link into your browser:<br/>
        <span class="code">${resetUrl}</span>
      </p>
      <p style="font-size:12px; color:#64748b;">This link expires in <strong>30 minutes</strong>. If you didn't request a password reset, you can safely ignore this email.</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} SOC-EYE &bull; Social Media Observation &amp; Cyber Intelligence
    </div>
  </div>
</body>
</html>`;

  try {
    const info = await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: toEmail,
      subject: 'SOC-EYE — Password Reset Request',
      html,
    });
    console.log(`[SMTP] Password reset email sent to ${toEmail}: ${info.messageId}`);
    return true;
  } catch (err) {
    console.error(`[SMTP] Failed to send reset email: ${err.message}`);
    return false;
  }
};

module.exports = { sendPasswordResetEmail, createTransporter };
