import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import mammoth from "mammoth";
import TurndownService from "turndown";
import AdmZip from "adm-zip";
import { PDFParse } from "pdf-parse";
import PptxGenJS from "pptxgenjs";

export type InputFormat = "pdf" | "docx" | "pptx" | "txt";
export type OutputFormat = "pdf" | "docx" | "pptx" | "md" | "txt";

export const INPUT_FORMATS: InputFormat[] = ["pdf", "docx", "pptx", "txt"];
export const OUTPUT_FORMATS: OutputFormat[] = ["pdf", "docx", "pptx", "md", "txt"];

// Conversion matrix. Every input can be converted to every output. For
// cross-format Office targets the free LibreOffice engine can't do natively
// (e.g. PDF -> DOCX, anything -> PPTX), we rebuild a clean text-based version
// from the extracted content — original images/layout are not preserved.
export const SUPPORTED_MATRIX: Record<InputFormat, OutputFormat[]> = {
  pdf: ["pdf", "docx", "pptx", "md", "txt"],
  docx: ["pdf", "docx", "pptx", "md", "txt"],
  pptx: ["pdf", "docx", "pptx", "md", "txt"],
  txt: ["pdf", "docx", "pptx", "md", "txt"],
};

export const MIME_TYPES: Record<OutputFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  md: "text/markdown",
  txt: "text/plain",
};

const execFileAsync = promisify(execFile);

export function detectInputFormat(originalName: string): InputFormat | null {
  const ext = path.extname(originalName).toLowerCase().replace(/^\./, "");
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "pptx") return "pptx";
  if (ext === "txt") return "txt";
  return null;
}

export function isSupported(input: InputFormat, output: OutputFormat): boolean {
  return SUPPORTED_MATRIX[input]?.includes(output) ?? false;
}

// Verify the file's actual magic bytes match the claimed type. This catches
// files renamed to the wrong extension and corrupted uploads before they reach
// the conversion engine. TXT has no signature, so it is always accepted.
export async function validateFileSignature(
  filePath: string,
  input: InputFormat,
): Promise<boolean> {
  if (input === "txt") return true;

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const buf = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buf, 0, 4, 0);

    if (input === "pdf") {
      // PDF files start with "%PDF".
      return bytesRead >= 4 && buf.toString("latin1", 0, 4) === "%PDF";
    }

    // DOCX and PPTX are ZIP archives, which start with "PK\x03\x04"
    // (or the empty/spanned variants "PK\x05\x06" / "PK\x07\x08").
    if (input === "docx" || input === "pptx") {
      if (bytesRead < 4) return false;
      if (buf[0] !== 0x50 || buf[1] !== 0x4b) return false;
      const third = buf[2];
      const fourth = buf[3];
      return (
        (third === 0x03 && fourth === 0x04) ||
        (third === 0x05 && fourth === 0x06) ||
        (third === 0x07 && fourth === 0x08)
      );
    }

    return false;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// The outcome of inspecting an Office archive's internal structure.
// "unreadable": the ZIP container itself can't be opened (truncated/corrupt).
// "missing-parts": the ZIP opens fine but lacks the parts that make it a real
// Word/PowerPoint document. Distinguishing the two lets us tell the user
// whether to re-download (broken container) or re-export (incomplete contents).
export type OfficeStructureResult =
  | { ok: true }
  | { ok: false; reason: "unreadable" | "missing-parts" };

// A file can pass the magic-byte check (correct ZIP "PK" header) yet be
// internally truncated or missing the parts that make it a real Office
// document. Opening the archive and confirming the expected structure lets us
// reject these up front with a clean 400 instead of failing deep in the
// conversion engine with a generic 500. Non-Office formats have no ZIP
// structure to inspect, so they always pass.
export function validateOfficeStructure(
  filePath: string,
  input: InputFormat,
): OfficeStructureResult {
  if (input !== "docx" && input !== "pptx") return { ok: true };

  let entries: ReturnType<AdmZip["getEntries"]>;
  try {
    entries = new AdmZip(filePath).getEntries();
  } catch {
    // AdmZip throws on a corrupt/unreadable archive.
    return { ok: false, reason: "unreadable" };
  }

  if (input === "docx") {
    // A Word document must contain the main document part.
    const hasMainPart = entries.some((e) => e.entryName === "word/document.xml");
    return hasMainPart ? { ok: true } : { ok: false, reason: "missing-parts" };
  }

  // A PowerPoint deck must contain at least one slide.
  const hasSlide = entries.some((e) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName),
  );
  return hasSlide ? { ok: true } : { ok: false, reason: "missing-parts" };
}

function baseName(originalName: string): string {
  const ext = path.extname(originalName);
  return path.basename(originalName, ext) || "document";
}

/* ── Text & Markdown extraction ───────────────────────────── */

async function extractPptxText(filePath: string): Promise<string[]> {
  const zip = new AdmZip(filePath);
  const entries = zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const na = parseInt(a.entryName.replace(/\D/g, ""), 10);
      const nb = parseInt(b.entryName.replace(/\D/g, ""), 10);
      return na - nb;
    });

  const slides: string[] = [];
  for (const entry of entries) {
    const xml = entry.getData().toString("utf8");
    const runs = xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [];
    const text = runs
      .map((r) => r.replace(/<a:t>([\s\S]*?)<\/a:t>/, "$1"))
      .map(decodeXmlEntities)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    slides.push(text);
  }
  return slides;
}

async function extractPdfText(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return (result.text || "").trim();
  } finally {
    await parser.destroy().catch(() => {});
  }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export async function extractPlainText(
  filePath: string,
  input: InputFormat,
): Promise<string> {
  if (input === "txt") {
    return await fs.readFile(filePath, "utf8");
  }
  if (input === "docx") {
    const { value } = await mammoth.extractRawText({ path: filePath });
    return value.trim();
  }
  if (input === "pdf") {
    return await extractPdfText(filePath);
  }
  if (input === "pptx") {
    const slides = await extractPptxText(filePath);
    return slides
      .map((s, i) => `Slide ${i + 1}\n${s}`.trim())
      .join("\n\n")
      .trim();
  }
  return "";
}

export async function extractMarkdown(
  filePath: string,
  input: InputFormat,
  originalName: string,
): Promise<string> {
  const title = baseName(originalName);

  if (input === "txt") {
    const text = await fs.readFile(filePath, "utf8");
    return `# ${title}\n\n${text.trim()}\n`;
  }

  if (input === "docx") {
    const { value: html } = await mammoth.convertToHtml({ path: filePath });
    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    const md = turndown.turndown(html).trim();
    return `# ${title}\n\n${md}\n`;
  }

  if (input === "pdf") {
    const text = await extractPdfText(filePath);
    const body = text
      .split(/\n{2,}/)
      .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
      .filter(Boolean)
      .join("\n\n");
    return `# ${title}\n\n${body}\n`;
  }

  if (input === "pptx") {
    const slides = await extractPptxText(filePath);
    const body = slides
      .map((s, i) => `## Slide ${i + 1}\n\n${s || "_(no text)_"}`)
      .join("\n\n");
    return `# ${title}\n\n${body}\n`;
  }

  return `# ${title}\n`;
}

/* ── LibreOffice rendering ─────────────────────────────────── */

async function convertWithLibreOffice(
  inputPath: string,
  targetExt: OutputFormat,
  outDir: string,
): Promise<string> {
  const profileDir = path.join(os.tmpdir(), `lo_profile_${randomUUID()}`);
  await fs.mkdir(profileDir, { recursive: true });
  try {
    await execFileAsync(
      "soffice",
      [
        "--headless",
        "--norestore",
        "--nolockcheck",
        `-env:UserInstallation=file://${profileDir}`,
        "--convert-to",
        targetExt,
        "--outdir",
        outDir,
        inputPath,
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024 * 64 },
    );
  } finally {
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }

  const produced = path.join(
    outDir,
    `${path.basename(inputPath, path.extname(inputPath))}.${targetExt}`,
  );
  await fs.access(produced);
  return produced;
}

// LibreOffice can't build a Word document from a PDF or PowerPoint directly, so
// for those we extract the plain text, write it to a temp .txt, and let
// LibreOffice render that text into a clean (text-only) .docx.
async function renderTextToDocx(text: string): Promise<Buffer> {
  const tmpTxt = path.join(os.tmpdir(), `conv_${randomUUID()}.txt`);
  const outDir = path.join(os.tmpdir(), `lo_out_${randomUUID()}`);
  await fs.writeFile(tmpTxt, text.length ? text : " ", "utf8");
  await fs.mkdir(outDir, { recursive: true });
  try {
    const produced = await convertWithLibreOffice(tmpTxt, "docx", outDir);
    return await fs.readFile(produced);
  } finally {
    await fs.rm(tmpTxt, { force: true }).catch(() => {});
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

// LibreOffice has no filter to turn a document into a presentation, so we build
// a clean text-based PowerPoint from the extracted content using pptxgenjs:
// a title slide, then content slides chunked from the document's text lines.
async function buildPptxFromText(title: string, text: string): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";

  const titleSlide = pptx.addSlide();
  titleSlide.addText(title || "Document", {
    x: 0.5,
    y: 2.4,
    w: 12.33,
    h: 1.5,
    fontSize: 36,
    bold: true,
    align: "center",
    color: "1F2937",
  });

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) lines.push("(No text content found in the document.)");

  const LINES_PER_SLIDE = 8;
  for (let i = 0; i < lines.length; i += LINES_PER_SLIDE) {
    const chunk = lines.slice(i, i + LINES_PER_SLIDE);
    const slide = pptx.addSlide();
    slide.addText(
      chunk.map((line) => ({
        text: line,
        options: { bullet: true, breakLine: true },
      })),
      { x: 0.6, y: 0.5, w: 12.1, h: 6.8, fontSize: 18, color: "1F2937", valign: "top" },
    );
  }

  const out = (await pptx.write({ outputType: "nodebuffer" })) as Buffer | Uint8Array;
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

/* ── Public conversion API ─────────────────────────────────── */

export async function convertDocument(params: {
  inputPath: string;
  input: InputFormat;
  output: OutputFormat;
  originalName: string;
}): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
  const { inputPath, input, output, originalName } = params;

  if (!isSupported(input, output)) {
    throw new Error(`Conversion from ${input} to ${output} is not supported.`);
  }

  const name = baseName(originalName);
  const mimeType = MIME_TYPES[output];

  // Markdown output (text extraction)
  if (output === "md") {
    const md = await extractMarkdown(inputPath, input, originalName);
    return { buffer: Buffer.from(md, "utf8"), filename: `${name}.md`, mimeType };
  }

  // Plain-text output (text extraction)
  if (output === "txt") {
    const text = await extractPlainText(inputPath, input);
    return { buffer: Buffer.from(text, "utf8"), filename: `${name}.txt`, mimeType };
  }

  // Same-format passthrough (pdf->pdf, docx->docx, pptx->pptx)
  if (input === (output as string)) {
    const buffer = await fs.readFile(inputPath);
    return { buffer, filename: `${name}.${output}`, mimeType };
  }

  // PowerPoint output: LibreOffice can't build a deck from a document, so we
  // generate a clean text-based presentation from the extracted content.
  if (output === "pptx") {
    const text = await extractPlainText(inputPath, input);
    const buffer = await buildPptxFromText(name, text);
    return { buffer, filename: `${name}.pptx`, mimeType };
  }

  // Word output: LibreOffice renders txt -> docx natively. For pdf/pptx it has
  // no direct filter, so we extract the text first and render that to docx.
  if (output === "docx") {
    if (input === "txt") {
      const outDir = path.join(os.tmpdir(), `lo_out_${randomUUID()}`);
      await fs.mkdir(outDir, { recursive: true });
      try {
        const producedPath = await convertWithLibreOffice(inputPath, "docx", outDir);
        const buffer = await fs.readFile(producedPath);
        return { buffer, filename: `${name}.docx`, mimeType };
      } finally {
        await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    const text = await extractPlainText(inputPath, input);
    const buffer = await renderTextToDocx(text);
    return { buffer, filename: `${name}.docx`, mimeType };
  }

  // PDF output: LibreOffice renders docx/pptx/txt -> pdf natively.
  const outDir = path.join(os.tmpdir(), `lo_out_${randomUUID()}`);
  await fs.mkdir(outDir, { recursive: true });
  try {
    const producedPath = await convertWithLibreOffice(inputPath, output, outDir);
    const buffer = await fs.readFile(producedPath);
    return { buffer, filename: `${name}.${output}`, mimeType };
  } finally {
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function cleanupFile(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  await fs.rm(filePath, { force: true }).catch(() => {});
}
