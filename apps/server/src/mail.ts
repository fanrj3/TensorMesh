import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const defaultTokenPath = "/etc/tensormesh/cloudmail.jwt";

export interface MailConfigInfo {
  configured: boolean;
  endpoint: string;
  fromName: string;
  tokenSource: "env" | "file" | "missing";
  tokenFile?: string;
}

export interface SendMailInput {
  toName: string;
  toMail: string;
  subject: string;
  isHtml: boolean;
  content: string;
}

export interface SendMailResult {
  status: number;
  body: string;
}

export interface MailDetail {
  label: string;
  value: string;
  monospace?: boolean;
}

export interface TensorMeshMailTemplateInput {
  title: string;
  recipientName: string;
  body: string;
  summaryLabel: string;
  summaryValue: string;
  details?: MailDetail[];
  notice: string;
  logTail?: string;
}

function endpoint(): string {
  return process.env.TENSORMESH_CLOUDMAIL_ENDPOINT?.trim() ?? "";
}

function fromName(): string {
  return process.env.TENSORMESH_MAIL_FROM_NAME?.trim() || "TensorMesh";
}

function tokenFile(): string {
  return process.env.TENSORMESH_CLOUDMAIL_TOKEN_FILE?.trim() || defaultTokenPath;
}

export function getMailConfigInfo(): MailConfigInfo {
  const envToken = process.env.TENSORMESH_CLOUDMAIL_TOKEN?.trim();
  const file = tokenFile();
  const hasFile = existsSync(file);
  return {
    configured: Boolean((envToken || hasFile) && endpoint()),
    endpoint: endpoint(),
    fromName: fromName(),
    tokenSource: envToken ? "env" : hasFile ? "file" : "missing",
    tokenFile: envToken ? undefined : file
  };
}

async function readCloudMailToken(): Promise<string> {
  const envToken = process.env.TENSORMESH_CLOUDMAIL_TOKEN?.trim();
  if (envToken) return envToken;

  const file = tokenFile();
  try {
    const token = (await readFile(file, "utf8")).trim();
    if (token) return token;
  } catch {
    // Report a clear configuration error below.
  }

  throw new Error(`CloudMail token is not configured. Set TENSORMESH_CLOUDMAIL_TOKEN_FILE or create ${file}`);
}

export async function sendCloudMail(input: SendMailInput): Promise<SendMailResult> {
  const target = endpoint();
  if (!target) throw new Error("TENSORMESH_CLOUDMAIL_ENDPOINT is not configured.");
  const token = await readCloudMailToken();
  const response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      token,
      from_name: fromName(),
      to_name: input.toName,
      to_mail: input.toMail,
      subject: input.subject,
      is_html: input.isHtml,
      content: input.content
    })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`CloudMail API returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return {
    status: response.status,
    body
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderLogTail(logTail: string | undefined): string {
  if (!logTail?.trim()) return "";
  const lines = logTail.trimEnd().split("\n").slice(-24).join("\n");
  return `<details class="log-details">
        <summary>查看日志最后 24 行</summary>
        <pre>${escapeHtml(lines)}</pre>
      </details>`;
}

export function renderTensorMeshMail(input: TensorMeshMailTemplateInput): string {
  const details = input.details ?? [];
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      margin: 0;
      padding: 40px 16px;
      background: #fafafa;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #171717;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      max-width: 520px;
      margin: 0 auto;
      background: #ffffff;
      border: 1px solid #e5e5e5;
      border-radius: 20px;
      overflow: hidden;
    }
    .header {
      padding: 36px 36px 24px;
      border-bottom: 1px solid #f5f5f5;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 30px;
      padding: 0 14px;
      border-radius: 9999px;
      background: #111111;
      color: #ffffff;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 700;
      letter-spacing: 0;
      color: #111111;
    }
    .content {
      padding: 32px 36px 36px;
      font-size: 15px;
      line-height: 1.7;
      color: #525252;
    }
    .greeting {
      margin-top: 0;
      margin-bottom: 18px;
      font-size: 16px;
      font-weight: 600;
      color: #111111;
    }
    .summary-box {
      margin: 28px 0;
      padding: 20px 22px;
      border-radius: 16px;
      background: #fafafa;
      border: 1px solid #eeeeee;
    }
    .summary-label {
      margin-bottom: 8px;
      font-size: 13px;
      color: #737373;
      font-weight: 500;
    }
    .summary-value {
      margin: 0;
      font-size: 34px;
      line-height: 1;
      font-weight: 700;
      letter-spacing: 0;
      color: #111111;
    }
    .details {
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px solid #eeeeee;
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 6px 0;
      font-size: 14px;
      line-height: 1.5;
    }
    .detail-label {
      color: #737373;
    }
    .detail-value {
      color: #111111;
      font-weight: 500;
      text-align: right;
      word-break: break-all;
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      font-weight: 400;
    }
    .notice {
      margin-top: 28px;
      padding-top: 20px;
      border-top: 1px solid #f1f1f1;
      font-size: 13px;
      color: #8a8a8a;
      line-height: 1.6;
    }
    .log-details {
      margin-top: 22px;
      padding-top: 18px;
      border-top: 1px solid #f1f1f1;
    }
    .log-details summary {
      cursor: pointer;
      color: #111111;
      font-size: 13px;
      font-weight: 600;
    }
    .log-details pre {
      overflow-x: auto;
      margin: 12px 0 0;
      padding: 14px;
      border: 1px solid #eeeeee;
      border-radius: 12px;
      background: #fafafa;
      color: #171717;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
    }
    .footer {
      padding: 22px 36px 32px;
      border-top: 1px solid #f5f5f5;
      background: #fcfcfc;
      text-align: center;
      font-size: 12px;
      line-height: 1.7;
      color: #a3a3a3;
    }
    strong {
      color: #111111;
      font-weight: 600;
    }
    @media (max-width: 560px) {
      body {
        padding: 20px 10px;
      }
      .header,
      .content,
      .footer {
        padding-left: 24px;
        padding-right: 24px;
      }
      h1 {
        font-size: 24px;
      }
      .summary-value {
        font-size: 28px;
      }
      .detail-row {
        display: block;
      }
      .detail-value {
        display: block;
        margin-top: 2px;
        text-align: left;
      }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="brand">TensorMesh</div>
      <h1>${escapeHtml(input.title)}</h1>
    </div>
    <div class="content">
      <p class="greeting">${escapeHtml(input.recipientName)}，您好：</p>
      <p>${escapeHtml(input.body)}</p>
      <div class="summary-box">
        <div class="summary-label">${escapeHtml(input.summaryLabel)}</div>
        <p class="summary-value">${escapeHtml(input.summaryValue)}</p>
        ${
          details.length > 0
            ? `<div class="details">${details
                .map(
                  (detail) => `<div class="detail-row">
            <span class="detail-label">${escapeHtml(detail.label)}</span>
            <span class="detail-value${detail.monospace ? " mono" : ""}">${escapeHtml(detail.value)}</span>
          </div>`
                )
                .join("")}</div>`
            : ""
        }
      </div>
      <div class="notice">${escapeHtml(input.notice)}</div>
      ${renderLogTail(input.logTail)}
    </div>
    <div class="footer">
      此邮件由 TensorMesh 自动发送，请勿直接回复。<br />
      © TensorMesh 保留所有权利。
    </div>
  </div>
</body>
</html>`;
}
