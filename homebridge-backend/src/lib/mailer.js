// src/lib/mailer.js
import nodemailer from "nodemailer";

const APP = process.env.APP_NAME || "GlobalCribs";
const FROM = process.env.FROM_EMAIL || `${APP} <no-reply@localhost>`;
const FRONTEND = process.env.FRONTEND_URL || "http://localhost:5173";

// Reuse a single transporter instance
let _tx;
function getTransport() {
  if (_tx) return _tx;

  const port = Number(process.env.SMTP_PORT || 465);
  const secure = port === 465; // 465 = TLS, otherwise STARTTLS

  _tx = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return _tx;
}

/** Low-level helper */
export async function sendMail({ to, subject, html, text, replyTo }) {
  const tx = getTransport();
  return tx.sendMail({ from: FROM, to, subject, html, text, replyTo });
}

/** Password reset email (existing flow) */
export async function sendPasswordResetEmail({ to, code }) {
  const subject = `${APP} password reset code`;

  const text = [
    `Use this code to reset your password: ${code}`,
    `It expires in 15 minutes.`,
    ``,
    `Open the reset page: ${FRONTEND}/reset?email=${encodeURIComponent(to)}`,
  ].join("\n");

  const html = `
    <p>Use this code to reset your password:</p>
    <p style="font-size:22px;letter-spacing:3px"><strong>${code}</strong></p>
    <p>It expires in 15 minutes.</p>
    <p><a href="${FRONTEND}/reset?email=${encodeURIComponent(to)}">Open reset page</a></p>
  `;

  return sendMail({ to, subject, text, html });
}

/** Support: auto-receipt after a ticket is created */
export async function sendSupportReceiptEmail({ to, ticketId, subject }) {
  const safeId = (ticketId || "").slice(0, 8);
  const html = `
    <p>Hi,</p>
    <p>We received your support request (<b>#${safeId}</b>):</p>
    <blockquote>${(subject || "Your request").replace(/</g, "&lt;")}</blockquote>
    <p>Our team will get back to you shortly.</p>
    <p>— ${APP} Support</p>
  `;
  return sendMail({
    to,
    subject: `${APP} Support – We received your request`,
    html,
  });
}

/** Support: admin reply to a ticket (emails the client) */
export async function sendSupportReplyEmail({ to, subject, body }) {
  const html = `<p>${String(body || "").replace(/\n/g, "<br/>")}</p><p>— ${APP} Support</p>`;
  return sendMail({
    to,
    subject: subject || `${APP} Support Reply`,
    html,
  });
}

/** Conversation: notify a student about an admin message */
export async function notifyStudentConversationEmail({
  to,
  subject,
  body,
  threadId,
  studentName,
}) {
  const safeSubj = subject || `New message from ${APP} Support`;
  const url = `${FRONTEND}/dashboard/student/messages${
    threadId ? `?thread=${encodeURIComponent(threadId)}` : ""
  }`;
  const html = `
    <p>${studentName ? `Hi ${studentName},` : "Hi,"}</p>
    <p>You have a new message from ${APP} Support:</p>
    <blockquote style="border-left:4px solid #ddd;padding-left:12px">${String(
      body || ""
    ).replace(/\n/g, "<br/>")}</blockquote>
    <p><a href="${url}">Open your messages</a></p>
    <p>— ${APP} Support</p>
  `;
  return sendMail({ to, subject: safeSubj, html });
}

/** Conversation: notify admins about a student message */
export async function notifyAdminsConversationEmail({
  to, // string or comma-separated list
  studentName,
  studentEmail,
  subject,
  body,
  studentId,
  threadId,
}) {
  const safeSubj = subject || `New message from ${studentName || "Student"}`;
  const url = `${FRONTEND}/admin/students/${studentId}#conversations`;
  const html = `
    <p>New message from ${studentName || "Student"} (${
    studentEmail || "no-email"
  })</p>
    <blockquote style="border-left:4px solid #ddd;padding-left:12px">${String(
      body || ""
    ).replace(/\n/g, "<br/>")}</blockquote>
    <p><a href="${url}">Open conversation in Admin</a></p>
  `;
  return sendMail({
    to,
    subject: safeSubj,
    html,
    replyTo: studentEmail || undefined,
  });
}
