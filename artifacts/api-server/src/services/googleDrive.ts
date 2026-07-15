import { google, type drive_v3 } from "googleapis";
import { Readable } from "node:stream";

const CONNECTOR_NAME = "google-drive";
const FOLDER_NAME = "Okiru Document Converter Records";

let connectionSettings: any;

async function getAccessToken(): Promise<string> {
  if (
    connectionSettings?.settings?.expires_at &&
    new Date(connectionSettings.settings.expires_at).getTime() > Date.now()
  ) {
    return connectionSettings.settings.access_token;
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    throw new Error("X_REPLIT_TOKEN not found for repl/depl");
  }
  if (!hostname) {
    throw new Error("REPLIT_CONNECTORS_HOSTNAME not set");
  }

  const data = (await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=${CONNECTOR_NAME}`,
    {
      headers: {
        Accept: "application/json",
        X_REPLIT_TOKEN: xReplitToken,
      },
    },
  ).then((res) => res.json())) as {
    items?: Array<{
      settings?: { access_token?: string; expires_at?: string };
    }>;
  };
  connectionSettings = data.items?.[0];

  const accessToken = connectionSettings?.settings?.access_token;
  if (!connectionSettings || !accessToken) {
    throw new Error("Google Drive not connected");
  }
  return accessToken;
}

// Never cache the returned client — tokens expire.
export async function getUncachableGoogleDriveClient(): Promise<drive_v3.Drive> {
  const accessToken = await getAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.drive({ version: "v3", auth: oauth2Client });
}

let cachedFolderId: string | null = null;

async function ensureFolder(drive: drive_v3.Drive): Promise<string> {
  if (cachedFolderId) return cachedFolderId;

  const existing = await drive.files.list({
    q: `mimeType='application/vnd.google-apps.folder' and name='${FOLDER_NAME}' and trashed=false`,
    fields: "files(id, name)",
    spaces: "drive",
  });

  const found = existing.data.files?.[0]?.id;
  if (found) {
    cachedFolderId = found;
    return found;
  }

  const created = await drive.files.create({
    requestBody: {
      name: FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
  });

  const id = created.data.id;
  if (!id) throw new Error("Failed to create Google Drive folder");
  cachedFolderId = id;
  return id;
}

export async function saveMarkdownToDrive(
  filename: string,
  content: string,
): Promise<string | null> {
  const drive = await getUncachableGoogleDriveClient();
  const folderId = await ensureFolder(drive);

  const created = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
      mimeType: "text/markdown",
    },
    media: {
      mimeType: "text/markdown",
      body: Readable.from([content]),
    },
    fields: "id",
  });

  return created.data.id ?? null;
}
