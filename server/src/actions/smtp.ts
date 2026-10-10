// smtp.send: send an email from a company mailbox (a Tier 2 shared asset). The mailbox password
// stays on the server; the session only names the recipients, subject and text.
//
// settings: host, port, security ("tls" = implicit TLS, usually 465; "starttls", usually 587;
//           "none" = plaintext, for a local relay or a test server only), from (the address),
//           fromName (optional)
// credentials: user, password (environment variables)
// Policy subjects: every recipient (to, cc), so an allow-list like ["*@example.org"] lets mail
// inside the company go out without an approval while anything leaving the company stops.
import { createTransport } from "nodemailer";
import type { ActionType } from "./index.ts";
import { emails, str } from "./index.ts";
import { httpError } from "../errors.ts";

const settingsOf = (s: Record<string, unknown> | undefined) => {
  const host = String(s?.host ?? "");
  const port = Number(s?.port ?? 587);
  const security = String(s?.security ?? "starttls");
  if (!["tls", "starttls", "none"].includes(security)) throw new Error("smtp.send: settings.security must be tls, starttls or none");
  return { host, port, security, from: String(s?.from ?? ""), fromName: s?.fromName ? String(s.fromName) : "" };
};

export const smtpSend: ActionType = {
  type: "smtp.send",
  tier: 2,
  requiredSettings: ["host", "from"],
  requiredCredentials: ["user", "password"],
  params: {
    to: { type: "string[]", required: true, description: "recipient addresses (at most 20)" },
    cc: { type: "string[]", required: false, description: "copy addresses (at most 20)" },
    subject: { type: "string", required: true, description: "one line, at most 200 characters" },
    text: { type: "string", required: true, description: "the plain-text body, at most 50000 characters" },
  },
  validate(p) {
    return {
      to: emails(p, "to", { required: true, max: 20 }),
      cc: emails(p, "cc", { required: false, max: 20 }),
      subject: str(p, "subject", { max: 200 }),
      text: str(p, "text", { max: 50_000, multiline: true }),
    };
  },
  subjects: (p) => [...(p.to as string[]), ...(p.cc as string[])],
  preview(p, config) {
    const s = settingsOf(config.settings);
    const to = (p.to as string[]).join(", ");
    const cc = (p.cc as string[]).join(", ");
    return {
      summary: `Send an email to ${to} from ${s.from}`,
      fields: [
        { label: "From", value: s.fromName ? `${s.fromName} <${s.from}>` : s.from },
        { label: "To", value: to },
        ...(cc ? [{ label: "Cc", value: cc }] : []),
        { label: "Subject", value: String(p.subject) },
      ],
      body: String(p.text),
    };
  },
  async run({ config, secrets, params }) {
    const s = settingsOf(config.settings);
    const transport = createTransport({
      host: s.host,
      port: s.port,
      secure: s.security === "tls",
      requireTLS: s.security === "starttls",
      ignoreTLS: s.security === "none",
      auth: { user: secrets.user!, pass: secrets.password! },
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 60_000,
    });
    try {
      const info = await transport.sendMail({
        from: s.fromName ? { name: s.fromName, address: s.from } : s.from,
        to: params.to as string[],
        cc: (params.cc as string[]).length ? (params.cc as string[]) : undefined,
        subject: String(params.subject),
        text: String(params.text),
      });
      return { messageId: info.messageId, accepted: info.accepted.map(String), rejected: info.rejected.map(String) };
    } catch (e) {
      // the server's reply only: never the credentials
      throw httpError("upstream", `the mail server refused: ${(e as Error).message.slice(0, 300)}`);
    } finally {
      transport.close();
    }
  },
};
