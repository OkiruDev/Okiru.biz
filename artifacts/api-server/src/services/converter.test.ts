import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import {
  detectInputFormat,
  isSupported,
  validateFileSignature,
  validateOfficeStructure,
  convertDocument,
  extractPlainText,
  extractMarkdown,
  cleanupFile,
  INPUT_FORMATS,
  OUTPUT_FORMATS,
  SUPPORTED_MATRIX,
  type InputFormat,
  type OutputFormat,
} from "./converter";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = path.join(os.tmpdir(), `converter_test_${randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

async function writeFixture(name: string, data: Buffer | string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, data);
  return p;
}

describe("detectInputFormat", () => {
  it("detects supported extensions regardless of case", () => {
    expect(detectInputFormat("report.pdf")).toBe("pdf");
    expect(detectInputFormat("notes.DOCX")).toBe("docx");
    expect(detectInputFormat("deck.PpTx")).toBe("pptx");
    expect(detectInputFormat("readme.txt")).toBe("txt");
  });

  it("returns null for unknown or missing extensions", () => {
    expect(detectInputFormat("image.png")).toBeNull();
    expect(detectInputFormat("archive.zip")).toBeNull();
    expect(detectInputFormat("noextension")).toBeNull();
  });
});

describe("isSupported / SUPPORTED_MATRIX", () => {
  it("matches the declared matrix for every input/output combination", () => {
    for (const input of INPUT_FORMATS) {
      for (const output of OUTPUT_FORMATS) {
        const expected = SUPPORTED_MATRIX[input].includes(output);
        expect(isSupported(input, output)).toBe(expected);
      }
    }
  });

  it("allows the documented supported conversions", () => {
    expect(isSupported("pdf", "txt")).toBe(true);
    expect(isSupported("docx", "pdf")).toBe(true);
    expect(isSupported("txt", "docx")).toBe(true);
    expect(isSupported("pptx", "md")).toBe(true);
  });

  it("supports text-based cross-format conversions for every input", () => {
    expect(isSupported("pdf", "docx")).toBe(true);
    expect(isSupported("pdf", "pptx")).toBe(true);
    expect(isSupported("txt", "pptx")).toBe(true);
    expect(isSupported("docx", "pptx")).toBe(true);
  });

  it("rejects an unrecognized output format", () => {
    expect(isSupported("pdf", "rtf" as OutputFormat)).toBe(false);
    expect(isSupported("txt", "" as OutputFormat)).toBe(false);
  });
});

describe("validateFileSignature", () => {
  it("always accepts txt (no signature)", async () => {
    const p = await writeFixture("plain.txt", "just some text");
    expect(await validateFileSignature(p, "txt")).toBe(true);
  });

  it("accepts a real PDF magic header and rejects a fake one", async () => {
    const good = await writeFixture("good.pdf", Buffer.from("%PDF-1.7\n..."));
    const bad = await writeFixture("bad.pdf", Buffer.from("not a pdf at all"));
    expect(await validateFileSignature(good, "pdf")).toBe(true);
    expect(await validateFileSignature(bad, "pdf")).toBe(false);
  });

  it("accepts a ZIP (PK) header for docx/pptx and rejects others", async () => {
    const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    const goodDocx = await writeFixture("good.docx", zipHeader);
    const goodPptx = await writeFixture("good.pptx", zipHeader);
    const badDocx = await writeFixture("bad.docx", Buffer.from("plain text not a zip"));
    expect(await validateFileSignature(goodDocx, "docx")).toBe(true);
    expect(await validateFileSignature(goodPptx, "pptx")).toBe(true);
    expect(await validateFileSignature(badDocx, "docx")).toBe(false);
  });

  it("returns false when the file is missing", async () => {
    expect(await validateFileSignature(path.join(tmpDir, "nope.pdf"), "pdf")).toBe(false);
  });
});

describe("validateOfficeStructure", () => {
  it("always accepts non-office formats", async () => {
    const txt = await writeFixture("plain2.txt", "text");
    const pdf = await writeFixture("doc.pdf", Buffer.from("%PDF-1.7"));
    expect(validateOfficeStructure(txt, "txt")).toEqual({ ok: true });
    expect(validateOfficeStructure(pdf, "pdf")).toEqual({ ok: true });
  });

  it("accepts a docx archive that contains word/document.xml", async () => {
    const zip = new AdmZip();
    zip.addFile("word/document.xml", Buffer.from("<w:document/>"));
    const p = path.join(tmpDir, "real.docx");
    await fs.writeFile(p, zip.toBuffer());
    expect(validateOfficeStructure(p, "docx")).toEqual({ ok: true });
  });

  it("flags a readable docx archive missing word/document.xml as missing-parts", async () => {
    const zip = new AdmZip();
    zip.addFile("docProps/core.xml", Buffer.from("<props/>"));
    const p = path.join(tmpDir, "nodoc.docx");
    await fs.writeFile(p, zip.toBuffer());
    expect(validateOfficeStructure(p, "docx")).toEqual({
      ok: false,
      reason: "missing-parts",
    });
  });

  it("accepts a pptx archive that contains a slide", async () => {
    const zip = new AdmZip();
    zip.addFile("ppt/slides/slide1.xml", Buffer.from("<p:sld/>"));
    const p = path.join(tmpDir, "real.pptx");
    await fs.writeFile(p, zip.toBuffer());
    expect(validateOfficeStructure(p, "pptx")).toEqual({ ok: true });
  });

  it("flags a readable pptx archive with no slides as missing-parts", async () => {
    const zip = new AdmZip();
    zip.addFile("ppt/presentation.xml", Buffer.from("<p:presentation/>"));
    const p = path.join(tmpDir, "noslides.pptx");
    await fs.writeFile(p, zip.toBuffer());
    expect(validateOfficeStructure(p, "pptx")).toEqual({
      ok: false,
      reason: "missing-parts",
    });
  });

  it("flags a file with a ZIP header but corrupt/truncated body as unreadable", async () => {
    // Valid "PK\x03\x04" magic bytes but not a readable archive.
    const p = await writeFixture(
      "truncated.docx",
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00]),
    );
    expect(await validateFileSignature(p, "docx")).toBe(true);
    expect(validateOfficeStructure(p, "docx")).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });
});

describe("text & markdown extraction (txt)", () => {
  it("extracts plain text verbatim", async () => {
    const p = await writeFixture("hello.txt", "Hello world\nLine two");
    expect(await extractPlainText(p, "txt")).toBe("Hello world\nLine two");
  });

  it("wraps txt content in a titled markdown document", async () => {
    const p = await writeFixture("My Notes.txt", "Body content here");
    const md = await extractMarkdown(p, "txt", "My Notes.txt");
    expect(md).toContain("# My Notes");
    expect(md).toContain("Body content here");
  });
});

describe("convertDocument (text-only paths)", () => {
  it("converts txt -> md", async () => {
    const p = await writeFixture("doc.txt", "Some text");
    const result = await convertDocument({
      inputPath: p,
      input: "txt",
      output: "md",
      originalName: "doc.txt",
    });
    expect(result.filename).toBe("doc.md");
    expect(result.mimeType).toBe("text/markdown");
    expect(result.buffer.toString("utf8")).toContain("# doc");
  });

  it("converts txt -> txt (extraction)", async () => {
    const p = await writeFixture("doc2.txt", "Plain body");
    const result = await convertDocument({
      inputPath: p,
      input: "txt",
      output: "txt",
      originalName: "doc2.txt",
    });
    expect(result.filename).toBe("doc2.txt");
    expect(result.mimeType).toBe("text/plain");
    expect(result.buffer.toString("utf8")).toBe("Plain body");
  });

  it("throws for an unrecognized output format", async () => {
    const p = await writeFixture("doc3.txt", "x");
    await expect(
      convertDocument({
        inputPath: p,
        input: "txt" as InputFormat,
        output: "rtf" as OutputFormat,
        originalName: "doc3.txt",
      }),
    ).rejects.toThrow(/not supported/i);
  });
});

/* ── Real binary fixtures ──────────────────────────────────────
 * The fast paths above use synthetic data. These exercise the heavy
 * conversion paths real users rely on: pdfjs text extraction, mammoth
 * (DOCX), PPTX slide-XML parsing, and LibreOffice rendering. The fixtures
 * are tiny real files generated once with LibreOffice and committed under
 * ./fixtures.
 */
const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
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

describe("binary text extraction (real fixtures)", () => {
  it("validates the committed fixtures (signature + structure)", async () => {
    expect(await validateFileSignature(fixture("sample.pdf"), "pdf")).toBe(true);
    expect(await validateFileSignature(fixture("sample.docx"), "docx")).toBe(true);
    expect(await validateFileSignature(fixture("sample.pptx"), "pptx")).toBe(true);
    expect(validateOfficeStructure(fixture("sample.docx"), "docx")).toEqual({ ok: true });
    expect(validateOfficeStructure(fixture("sample.pptx"), "pptx")).toEqual({ ok: true });
  });

  it("extracts text from a real PDF (pdfjs)", async () => {
    const text = await extractPlainText(fixture("sample.pdf"), "pdf");
    expect(text).toContain("Okiru Conversion Test Fixture");
    expect(text).toContain("The quick brown fox jumps over the lazy dog.");
  });

  it("extracts text from a real DOCX (mammoth)", async () => {
    const text = await extractPlainText(fixture("sample.docx"), "docx");
    expect(text).toContain("Okiru Conversion Test Fixture");
    expect(text).toContain("The quick brown fox jumps over the lazy dog.");
  });

  it("extracts per-slide text from a real PPTX (slide XML)", async () => {
    const text = await extractPlainText(fixture("sample.pptx"), "pptx");
    expect(text).toContain("Slide 1");
    expect(text).toContain("Slide 2");
    expect(text).toContain("Okiru Slide One");
    expect(text).toContain("Okiru Slide Two");
  });

  it("renders markdown from a real PPTX with per-slide headings", async () => {
    const md = await extractMarkdown(fixture("sample.pptx"), "pptx", "sample.pptx");
    expect(md).toContain("# sample");
    expect(md).toContain("## Slide 1");
    expect(md).toContain("## Slide 2");
    expect(md).toContain("Okiru Slide One");
  });

  it("converts a real PDF -> md via convertDocument", async () => {
    const result = await convertDocument({
      inputPath: fixture("sample.pdf"),
      input: "pdf",
      output: "md",
      originalName: "sample.pdf",
    });
    expect(result.filename).toBe("sample.md");
    expect(result.mimeType).toBe("text/markdown");
    const md = result.buffer.toString("utf8");
    expect(md).toContain("# sample");
    expect(md).toContain("The quick brown fox jumps over the lazy dog.");
  });
});

describe.skipIf(!soffice)("LibreOffice rendering (real fixtures)", () => {
  it("renders DOCX -> PDF with valid magic bytes and mime type", async () => {
    const result = await convertDocument({
      inputPath: fixture("sample.docx"),
      input: "docx",
      output: "pdf",
      originalName: "sample.docx",
    });
    expect(result.filename).toBe("sample.pdf");
    expect(result.mimeType).toBe("application/pdf");
    expect(result.buffer.length).toBeGreaterThan(0);
    // A real PDF starts with "%PDF" and ends with the EOF marker.
    expect(result.buffer.toString("latin1", 0, 4)).toBe("%PDF");
    expect(result.buffer.toString("latin1")).toContain("%%EOF");
  });

  it("renders TXT -> DOCX as a valid ZIP-based Office document", async () => {
    const src = path.join(tmpDir, "render.txt");
    await fs.writeFile(src, "LibreOffice render check\nSecond line.");
    const result = await convertDocument({
      inputPath: src,
      input: "txt",
      output: "docx",
      originalName: "render.txt",
    });
    expect(result.filename).toBe("render.docx");
    expect(result.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(result.buffer.length).toBeGreaterThan(0);
    // DOCX is a ZIP archive: "PK\x03\x04".
    expect(result.buffer[0]).toBe(0x50);
    expect(result.buffer[1]).toBe(0x4b);
    expect(result.buffer[2]).toBe(0x03);
    expect(result.buffer[3]).toBe(0x04);

    // The rendered DOCX must round-trip back to readable text.
    const out = path.join(tmpDir, "rendered.docx");
    await fs.writeFile(out, result.buffer);
    expect(validateOfficeStructure(out, "docx")).toEqual({ ok: true });
    const text = await extractPlainText(out, "docx");
    expect(text).toContain("LibreOffice render check");
  });
});

describe("cleanupFile", () => {
  it("removes an existing file and is a no-op otherwise", async () => {
    const p = await writeFixture("temp.txt", "bye");
    await cleanupFile(p);
    await expect(fs.access(p)).rejects.toThrow();
    await expect(cleanupFile(undefined)).resolves.toBeUndefined();
    await expect(cleanupFile(path.join(tmpDir, "ghost.txt"))).resolves.toBeUndefined();
  });
});
