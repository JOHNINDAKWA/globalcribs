// src/lib/mailer.js
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465, // true for 465, else STARTTLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// generic helper used by feature emails
export async function sendMail({ to, subject, html, text }) {
  const appName = process.env.APP_NAME || "HomeBridge";
  const from = process.env.FROM_EMAIL || `${appName} <no-reply@localhost>`;
  await transporter.sendMail({ from, to, subject, html, text });
}

// existing reset-email helper (unchanged)
export async function sendPasswordResetEmail({ to, code }) {
  const appName = process.env.APP_NAME || "HomeBridge";
  const from = process.env.FROM_EMAIL || `${appName} <no-reply@yourdomain>`;
  const frontend = process.env.FRONTEND_URL || "http://localhost:5173";
  const subject = `${appName} password reset code`;

  const text = [
    `Use this code to reset your password: ${code}`,
    `It expires in 15 minutes.`,
    ``,
    `Open the reset page: ${frontend}/reset?email=${encodeURIComponent(to)}`
  ].join("\n");

  const html = `
    <p>Use this code to reset your password:</p>
    <p style="font-size:22px;letter-spacing:3px"><strong>${code}</strong></p>
    <p>It expires in 15 minutes.</p>
    <p><a href="${frontend}/reset?email=${encodeURIComponent(to)}">Open reset page</a></p>
  `;

  await transporter.sendMail({ from, to, subject, text, html });
}
