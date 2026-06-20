// Transactional email via Resend's REST API (no SDK dependency — a single
// fetch). Used for the email-verification OTP. Email is OPTIONAL: when it isn't
// configured (no RESEND_API_KEY / MAIL_ADDRESS), sending is a no-op and email
// verification is simply not required — so self-host without email keeps working.

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const MAIL_ADDRESS = process.env.MAIL_ADDRESS ?? "";
const APP_NAME = process.env.APP_NAME ?? "MergN";

/** True when transactional email is configured for this deployment. */
export function emailEnabled(): boolean {
  return Boolean(RESEND_API_KEY && MAIL_ADDRESS);
}

// Generic transactional send for callers beyond OTP (e.g. alert escalation).
// Throws on failure so the caller can fall back; no-op when email is unconfigured.
export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  return send(to, subject, html);
}

async function send(to: string, subject: string, html: string): Promise<void> {
  if (!emailEnabled()) return; // no-op when email isn't configured
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: MAIL_ADDRESS, to, subject, html }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`email send failed (${res.status}): ${detail.slice(0, 300)}`);
  }
}

function otpHtml(code: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;background:#0b0b0d;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e7e7ea">
    <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px">
      <tr><td align="center">
        <table width="100%" style="max-width:440px;background:#161618;border:1px solid #26262a;border-radius:16px;padding:32px">
          <tr><td>
            <div style="font-size:15px;font-weight:600;letter-spacing:.02em">${APP_NAME}</div>
            <h1 style="margin:20px 0 8px;font-size:20px;font-weight:600">Verify your email</h1>
            <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#a1a1aa">
              Enter this code in the app to finish signing up. It expires in 10 minutes.
            </p>
            <div style="font-size:34px;font-weight:700;letter-spacing:.35em;text-align:center;
                        padding:18px 0;background:#0b0b0d;border:1px solid #26262a;border-radius:12px;
                        font-family:ui-monospace,SFMono-Regular,Menlo,monospace;user-select:all">${code}</div>
            <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#71717a">
              If you didn't request this, you can safely ignore this email.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

/** Send the 6-digit email-verification OTP. No-op when email isn't configured. */
export async function sendVerificationOtp(
  email: string,
  code: string,
): Promise<void> {
  await send(email, `${APP_NAME} verification code: ${code}`, otpHtml(code));
}
