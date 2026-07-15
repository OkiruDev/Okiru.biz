import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import AdmZip from "adm-zip";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Mock the Google Drive service so tests never touch a live connection. The
// background record-save is fire-and-forget; these mocks let us assert it is
// invoked (or fails) without affecting the user-facing response.
vi.mock("../services/googleDrive", () => ({
  saveMarkdownToDrive: vi.fn(async () => "mock-drive-file-id"),
}));

import { saveMarkdownToDrive } from "../services/googleDrive";
import converterRouter from "./converter";

const mockedSave = vi.mocked(saveMarkdownToDrive);

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/api", converterRouter);
  return app;
}

const app = makeApp();

// Poll until the fire-and-forget Drive save has run (or time out).
async function waitForDriveCall(timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (mockedSave.mock.calls.length === 0) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("saveMarkdownToDrive was not called in time");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(() => {
  mockedSave.mockClear();
  mockedSave.mockImplementation(async () => "mock-drive-file-id");
});

describe("GET /api/converter/formats", () => {
  it("returns the supported matrix and limits", async () => {
    const res = await request(app).get("/api/converter/formats");
    expect(res.status).toBe(200);
    expect(res.body.matrix).toMatchObject({
      pdf: expect.arrayContaining(["txt"]),
      docx: expect.arrayContaining(["pdf"]),
    });
    expect(res.body.outputs).toEqual(
      expect.arrayContaining(["pdf", "docx", "pptx", "md", "txt"]),
    );
    expect(res.body.maxFileSize).toBe(20 * 1024 * 1024);
    expect(res.body.maxFiles).toBe(20);
  });
});

describe("POST /api/converter/convert — request validation", () => {
  it("returns 400 when no files are uploaded", async () => {
    const res = await request(app).post("/api/converter/convert").field("output", "md");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no files/i);
  });

  it("returns 400 for an invalid output format", async () => {
    const res = await request(app)
      .post("/api/converter/convert")
      .field("output", "bogus")
      .attach("files", Buffer.from("hello"), "note.txt");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid output format/i);
  });
});

describe("POST /api/converter/convert — supported conversions", () => {
  it("converts a supported txt -> md and returns 200 with content", async () => {
    const res = await request(app)
      .post("/api/converter/convert")
      .field("output", "md")
      .attach("files", Buffer.from("Hello body"), "greeting.txt");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    const r = res.body.results[0];
    expect(r.ok).toBe(true);
    expect(r.filename).toBe("greeting.md");
    expect(r.mimeType).toBe("text/markdown");
    const decoded = Buffer.from(r.contentBase64, "base64").toString("utf8");
    expect(decoded).toContain("# greeting");
    expect(decoded).toContain("Hello body");
  });

  it("zips the output when 2+ files succeed", async () => {
    const res = await request(app)
      .post("/api/converter/convert")
      .field("output", "txt")
      .attach("files", Buffer.from("one"), "a.txt")
      .attach("files", Buffer.from("two"), "b.txt");

    expect(res.status).toBe(200);
    const oks = res.body.results.filter((r: { ok: boolean }) => r.ok);
    expect(oks).toHaveLength(2);
    expect(typeof res.body.zipBase64).toBe("string");
    expect(res.body.zipName).toBe("converted-documents.zip");
  });
});

describe("POST /api/converter/convert — per-file errors (still HTTP 200)", () => {
  it("reports an unsupported file type", async () => {
    const res = await request(app)
      .post("/api/converter/convert")
      .field("output", "md")
      .attach("files", Buffer.from("data"), "image.png");

    expect(res.status).toBe(200);
    const r = res.body.results[0];
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsupported file type/i);
  });

  it("reports a file whose contents don't match its extension", async () => {
    const res = await request(app)
      .post("/api/converter/convert")
      .field("output", "pdf")
      .attach("files", Buffer.from("this is not a real docx"), "fake.docx");

    expect(res.status).toBe(200);
    const r = res.body.results[0];
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/doesn't look like a valid docx/i);
  });

  it("reports a valid ZIP that is missing the Office structure", async () => {
    // A real ZIP (passes the magic-byte check) but with no word/document.xml,
    // i.e. a damaged/incomplete docx. This must be a clean per-file error, not
    // a 500 from deep inside the conversion engine.
    const zip = new AdmZip();
    zip.addFile("docProps/core.xml", Buffer.from("<props/>"));
    const res = await request(app)
      .post("/api/converter/convert")
      .field("output", "pdf")
      .attach("files", zip.toBuffer(), "broken.docx");

    expect(res.status).toBe(200);
    const r = res.body.results[0];
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/main Word document content is missing/i);
  });
});

describe("POST /api/converter/convert — upload limits", () => {
  it("returns 413 when a file exceeds the size limit", async () => {
    const tooBig = Buffer.alloc(20 * 1024 * 1024 + 1024, 0x61);
    const res = await request(app)
      .post("/api/converter/convert")
      .field("output", "txt")
      .attach("files", tooBig, "huge.txt");

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
  });

  it("returns 413 when too many files are uploaded", async () => {
    let req = request(app).post("/api/converter/convert").field("output", "txt");
    for (let i = 0; i < 21; i++) {
      req = req.attach("files", Buffer.from(`file ${i}`), `f${i}.txt`);
    }
    const res = await req;
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too many files/i);
  });
});

describe("POST /api/converter/convert — Google Drive is non-blocking", () => {
  it("saves an internal Markdown record on success", async () => {
    const res = await request(app)
      .post("/api/converter/convert")
      .field("output", "txt")
      .attach("files", Buffer.from("record me"), "saved.txt");

    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(true);

    await waitForDriveCall();
    expect(mockedSave).toHaveBeenCalledTimes(1);
    const [driveName, markdown] = mockedSave.mock.calls[0];
    expect(driveName).toMatch(/^saved-\d+\.md$/);
    expect(markdown).toContain("record me");
  });

  it("still returns the converted download when the Drive save fails", async () => {
    mockedSave.mockImplementation(async () => {
      throw new Error("Google Drive not connected");
    });

    const res = await request(app)
      .post("/api/converter/convert")
      .field("output", "md")
      .attach("files", Buffer.from("user content"), "important.txt");

    // The user's conversion succeeds regardless of the Drive failure.
    expect(res.status).toBe(200);
    const r = res.body.results[0];
    expect(r.ok).toBe(true);
    expect(r.filename).toBe("important.md");
    const decoded = Buffer.from(r.contentBase64, "base64").toString("utf8");
    expect(decoded).toContain("user content");

    // The (failed) Drive save was still attempted in the background.
    await waitForDriveCall();
    expect(mockedSave).toHaveBeenCalled();
  });
});

/* ── End-to-end with real binary fixtures ──────────────────────
 * The tests above drive synthetic buffers through the route. These push the
 * real committed fixtures (a genuine DOCX/PDF) through the full HTTP path —
 * multipart parsing, signature + structure validation, the conversion engine,
 * and the JSON download envelope — so route wiring can't silently break.
 *
 * The endpoint is a batch API: it always answers 200 with a per-file results[]
 * array and base64-encoded output (the "download"). True request-level failures
 * (no files, bad output format) are the only genuine 4xx responses; per-file
 * problems (unsupported combo, corrupt/mismatched file) surface as a clean
 * ok:false entry inside the 200 envelope — never an unhandled 500.
 */
const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "services",
  "fixtures",
);
const fixture = (name: string) => path.join(fixturesDir, name);

function hasSoffice(): boolean {
  try {
    execFileSync("soffice", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const soffice = hasSoffice();

describe("POST /api/converter/convert — end-to-end with real fixtures", () => {
  it.skipIf(!soffice)(
    "uploads a real DOCX, requests PDF, and returns a non-empty %PDF download",
    async () => {
      const res = await request(app)
        .post("/api/converter/convert")
        .field("output", "pdf")
        .attach("files", fixture("sample.docx"));

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);

      const r = res.body.results[0];
      expect(r.ok).toBe(true);
      expect(r.filename).toBe("sample.pdf");
      expect(r.mimeType).toBe("application/pdf");

      const pdf = Buffer.from(r.contentBase64, "base64");
      expect(pdf.length).toBeGreaterThan(0);
      // A real PDF starts with "%PDF" and ends with the EOF marker.
      expect(pdf.toString("latin1", 0, 4)).toBe("%PDF");
      expect(pdf.toString("latin1")).toContain("%%EOF");
    },
  );

  it("uploads a real PDF, requests TXT, and downloads the extracted text", async () => {
    const res = await request(app)
      .post("/api/converter/convert")
      .field("output", "txt")
      .attach("files", fixture("sample.pdf"));

    expect(res.status).toBe(200);
    const r = res.body.results[0];
    expect(r.ok).toBe(true);
    expect(r.filename).toBe("sample.txt");
    expect(r.mimeType).toBe("text/plain");

    const text = Buffer.from(r.contentBase64, "base64").toString("utf8");
    expect(text).toContain("The quick brown fox jumps over the lazy dog.");
  });

  it("rejects an unsupported output format for a real upload with a clean 400", async () => {
    const res = await request(app)
      .post("/api/converter/convert")
      .field("output", "rtf")
      .attach("files", fixture("sample.pdf"));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid output format/i);
  });

  it("converts a real PDF into a text-based PowerPoint (no engine needed)", async () => {
    // PDF -> PPTX is built from extracted text via pptxgenjs, so it does not
    // depend on LibreOffice. The result must be a valid .pptx (a ZIP, "PK").
    const res = await request(app)
      .post("/api/converter/convert")
      .field("output", "pptx")
      .attach("files", fixture("sample.pdf"));

    expect(res.status).toBe(200);
    const r = res.body.results[0];
    expect(r.ok).toBe(true);
    expect(r.filename).toBe("sample.pptx");
    expect(r.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );

    const pptx = Buffer.from(r.contentBase64, "base64");
    expect(pptx.length).toBeGreaterThan(0);
    expect(pptx.toString("latin1", 0, 2)).toBe("PK");
    // The generated deck must contain at least one real slide part.
    const names = new AdmZip(pptx).getEntries().map((e) => e.entryName);
    expect(names.some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toBe(true);
  });

  it.skipIf(!soffice)(
    "converts a real PDF into a text-based Word document",
    async () => {
      const res = await request(app)
        .post("/api/converter/convert")
        .field("output", "docx")
        .attach("files", fixture("sample.pdf"));

      expect(res.status).toBe(200);
      const r = res.body.results[0];
      expect(r.ok).toBe(true);
      expect(r.filename).toBe("sample.docx");
      expect(r.mimeType).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );

      const docx = Buffer.from(r.contentBase64, "base64");
      expect(docx.toString("latin1", 0, 2)).toBe("PK");
      const names = new AdmZip(docx).getEntries().map((e) => e.entryName);
      expect(names).toContain("word/document.xml");
    },
  );

  it("surfaces a real file with a mismatched extension as a clean error, not a 500", async () => {
    // Genuine PDF bytes uploaded under a .docx name. The signature check must
    // catch the mismatch and return a clean per-file error rather than letting
    // the conversion engine blow up with a 500.
    const pdfBytes = await fs.readFile(fixture("sample.pdf"));
    const res = await request(app)
      .post("/api/converter/convert")
      .field("output", "pdf")
      .attach("files", pdfBytes, "mislabeled.docx");

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
    const r = res.body.results[0];
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/doesn't look like a valid docx/i);
  });
});
