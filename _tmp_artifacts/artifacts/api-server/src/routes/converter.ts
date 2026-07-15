import { Router } from "express";
import multer from "multer";
import type { ErrorRequestHandler } from "express";
import AdmZip from "adm-zip";
import {
  detectInputFormat,
  isSupported,
  validateFileSignature,
  validateOfficeStructure,
  convertDocument,
  extractMarkdown,
  cleanupFile,
  OUTPUT_FORMATS,
  SUPPORTED_MATRIX,
  type InputFormat,
  type OutputFormat,
} from "../services/converter";
import { saveMarkdownToDrive } from "../services/googleDrive";
import { logger } from "../lib/logger";

const converterRouter = Router();

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const MAX_FILES = 20;

const upload = multer({
  dest: "server/uploads/",
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
});

// Expose the supported conversion matrix so the UI can disable bad combos.
converterRouter.get("/converter/formats", (_req, res) => {
  res.json({
    matrix: SUPPORTED_MATRIX,
    outputs: OUTPUT_FORMATS,
    maxFileSize: MAX_FILE_SIZE,
    maxFiles: MAX_FILES,
  });
});

type FileResult =
  | {
      name: string;
      ok: true;
      filename: string;
      mimeType: string;
      contentBase64: string;
    }
  | {
      name: string;
      ok: false;
      error: string;
    };

// Fire-and-forget: build the internal Markdown record from the upload and store
// it in the owner's Google Drive. Failures here never reach the user. Each
// invocation is responsible for cleaning up its own temp upload afterwards.
function saveRecordAndCleanup(
  sourcePath: string,
  input: InputFormat,
  originalName: string,
): void {
  void (async () => {
    try {
      const markdown = await extractMarkdown(sourcePath, input, originalName);
      const driveName = `${originalName.replace(/\.[^.]+$/, "")}-${Date.now()}.md`;
      const id = await saveMarkdownToDrive(driveName, markdown);
      if (id) logger.info({ driveFileId: id }, "Internal Markdown record saved to Drive");
    } catch (recordErr) {
      logger.error({ err: recordErr }, "Internal Markdown record failed");
    } finally {
      await cleanupFile(sourcePath);
    }
  })();
}

// Build a user-friendly message for a damaged Office file, distinguishing a
// broken container (re-download) from missing contents (re-export). We avoid
// internal part names like word/document.xml and speak in plain terms instead.
function officeStructureError(
  input: InputFormat,
  reason: "unreadable" | "missing-parts",
): string {
  const label = input.toUpperCase();
  if (reason === "unreadable") {
    return `This ${label} file's contents couldn't be opened — the file appears truncated or corrupted. Try downloading or copying the original file again.`;
  }
  if (input === "docx") {
    return "This DOCX file opened, but its main Word document content is missing. Try re-exporting or re-saving it from your word processor.";
  }
  return "This PPTX file opened, but it doesn't contain any slides. Try re-exporting or re-saving it from your presentation app.";
}

// Convert a single uploaded file. Validation failures are returned as a
// per-file error rather than thrown, so one bad file never sinks the batch.
// On success, the temp upload is handed to the background Drive recorder, which
// cleans it up; on failure we clean up here.
async function convertOne(
  file: Express.Multer.File,
  output: OutputFormat,
): Promise<FileResult> {
  const originalName = file.originalname;
  const input = detectInputFormat(originalName);

  if (!input) {
    await cleanupFile(file.path);
    return {
      name: originalName,
      ok: false,
      error: "Unsupported file type. Please upload a PDF, DOCX, PPTX, or TXT file.",
    };
  }

  if (!isSupported(input, output)) {
    await cleanupFile(file.path);
    return {
      name: originalName,
      ok: false,
      error: `Converting ${input.toUpperCase()} to ${output.toUpperCase()} is not supported.`,
    };
  }

  const signatureValid = await validateFileSignature(file.path, input);
  if (!signatureValid) {
    await cleanupFile(file.path);
    return {
      name: originalName,
      ok: false,
      error: `This file doesn't look like a valid ${input.toUpperCase()} file. It may be corrupted or have the wrong extension.`,
    };
  }

  // A DOCX/PPTX can have the right ZIP header but be internally truncated or
  // missing its core parts. Catch that here for a clean 400 instead of a 500,
  // and tell the user which kind of damage we found so they know what to do.
  const structure = validateOfficeStructure(file.path, input);
  if (!structure.ok) {
    await cleanupFile(file.path);
    return {
      name: originalName,
      ok: false,
      error: officeStructureError(input, structure.reason),
    };
  }

  try {
    const result = await convertDocument({
      inputPath: file.path,
      input,
      output,
      originalName,
    });

    // Best-effort, background: save the internal Markdown record to Drive and
    // clean up the temp upload. Must not affect the user-facing result.
    saveRecordAndCleanup(file.path, input, originalName);

    return {
      name: originalName,
      ok: true,
      filename: result.filename,
      mimeType: result.mimeType,
      contentBase64: result.buffer.toString("base64"),
    };
  } catch (error) {
    logger.error({ err: error, file: originalName }, "Converter convert error");
    await cleanupFile(file.path);
    return {
      name: originalName,
      ok: false,
      error: "Conversion failed. Please try again.",
    };
  }
}

// Ensure filenames inside the zip are unique so files that convert to the same
// output name (e.g. report.docx + report.pdf both -> report.txt) don't clobber.
function uniqueZipName(used: Set<string>, filename: string): string {
  if (!used.has(filename)) {
    used.add(filename);
    return filename;
  }
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  let i = 2;
  let candidate = `${stem} (${i})${ext}`;
  while (used.has(candidate)) {
    i += 1;
    candidate = `${stem} (${i})${ext}`;
  }
  used.add(candidate);
  return candidate;
}

converterRouter.post(
  "/converter/convert",
  upload.array("files", MAX_FILES),
  async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    try {
      if (files.length === 0) {
        res.status(400).json({ error: "No files uploaded." });
        return;
      }

      const output = String(req.body.output || "").toLowerCase() as OutputFormat;
      if (!OUTPUT_FORMATS.includes(output)) {
        await Promise.all(files.map((f) => cleanupFile(f.path)));
        res.status(400).json({ error: "Please choose a valid output format." });
        return;
      }

      // Convert sequentially: LibreOffice conversions are heavy, so running them
      // in parallel could exhaust memory/CPU on a batch of large files.
      const results: FileResult[] = [];
      for (const file of files) {
        results.push(await convertOne(file, output));
      }

      // Bundle every successful conversion into a single zip for one-click
      // "download all". Only built when 2+ files succeed; a lone file is simpler
      // to grab from its own download link.
      const successes = results.filter((r): r is Extract<FileResult, { ok: true }> => r.ok);
      let zipBase64: string | undefined;
      const zipName = "converted-documents.zip";
      if (successes.length >= 2) {
        const zip = new AdmZip();
        const used = new Set<string>();
        for (const s of successes) {
          const entryName = uniqueZipName(used, s.filename);
          zip.addFile(entryName, Buffer.from(s.contentBase64, "base64"));
        }
        zipBase64 = zip.toBuffer().toString("base64");
      }

      res.json({ results, zipBase64, zipName });
    } catch (error) {
      logger.error({ err: error }, "Converter batch error");
      await Promise.all(files.map((f) => cleanupFile(f.path)));
      if (!res.headersSent) {
        res.status(500).json({ error: "Conversion failed. Please try again." });
      }
    }
  },
);

// Friendly multer errors (e.g. file too large, too many files).
const converterErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: "A file is too large. The maximum size is 20 MB each." });
    return;
  }
  if (err && err.code === "LIMIT_FILE_COUNT") {
    res.status(413).json({ error: `Too many files. You can convert up to ${MAX_FILES} at once.` });
    return;
  }
  if (err) {
    res.status(400).json({ error: "Upload failed. Please try again." });
    return;
  }
  next();
};
converterRouter.use(converterErrorHandler);

export default converterRouter;
