import { useState } from "react";

export default function DocumentConverter() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<any>(null);

  async function uploadFile() {
    if (!file) {
      setStatus("Please choose a file first.");
      return;
    }

    setStatus("Uploading file...");
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch("/api/converter/upload", {
      method: "POST",
      body: formData,
    });

    const data = await response.json();

    if (!response.ok) {
      setStatus(data.error || "Upload failed.");
      return;
    }

    setResult(data);
    setStatus("File uploaded successfully.");
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white p-8">
      <div className="mx-auto max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 p-8">
        <h1 className="text-3xl font-bold">Okiru Document Converter</h1>

        <p className="mt-3 text-slate-300">
          Upload a PDF, PPTX, or Markdown file. This first version only tests upload.
        </p>

        <div className="mt-8 rounded-xl border border-dashed border-slate-600 bg-slate-950 p-6">
          <input
            type="file"
            accept=".pdf,.pptx,.md"
            onChange={(event) => setFile(event.target.files?.[0] || null)}
          />

          {file && (
            <p className="mt-4 text-sm text-slate-300">
              Selected: <strong>{file.name}</strong>
            </p>
          )}

          <button
            onClick={uploadFile}
            className="mt-6 rounded-lg bg-white px-5 py-3 font-semibold text-slate-950"
          >
            Upload Test
          </button>
        </div>

        {status && <p className="mt-6 text-sm text-slate-300">{status}</p>}

        {result && (
          <pre className="mt-6 overflow-auto rounded-xl bg-black p-4 text-xs text-green-300">
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
