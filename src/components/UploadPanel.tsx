'use client';

import { useState, useRef } from 'react';
import DocumentList, { type Document } from './DocumentList';

type InputMode = 'pdf' | 'text';
type UploadMode = 'Add' | 'Replace' | 'Delete';

interface UploadResult {
  status: string;
  chunks?: number;
  reason?: string;
  error?: string;
}

interface UploadPanelProps {
  documents: Document[];
  onDocumentsChange: () => void;
  refreshing?: boolean;
}

export default function UploadPanel({ documents, onDocumentsChange, refreshing }: UploadPanelProps) {
  const [inputMode, setInputMode] = useState<InputMode>('pdf');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [textContent, setTextContent] = useState('');
  const [filename, setFilename] = useState('');
  const [mode, setMode] = useState<UploadMode>('Add');
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setPdfFile(file);
      if (!filename) {
        setFilename(file.name);
      }
      setResult(null);
    }
  };

  const handleUpload = async () => {
    if (inputMode === 'pdf' && !pdfFile) return;
    if (inputMode === 'text' && !textContent.trim()) return;
    if (!filename.trim()) return;

    setUploading(true);
    setResult(null);

    try {
      let content: string;

      if (inputMode === 'pdf') {
        // Read PDF as base64
        content = await readFileAsBase64(pdfFile!);
      } else {
        content = textContent;
      }

      const response = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: inputMode,
          content,
          name: filename.trim(),
          mode,
        }),
      });

      const data = await response.json();
      setResult(data);

      // Refresh documents list on success
      if (['Added', 'Updated', 'Deleted'].includes(data.status)) {
        onDocumentsChange();
        // Reset form on success
        if (inputMode === 'pdf') {
          setPdfFile(null);
          if (fileInputRef.current) fileInputRef.current.value = '';
        } else {
          setTextContent('');
        }
        setFilename('');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      setResult({ status: 'Error', error: message });
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (docFilename: string) => {
    setUploading(true);
    setResult(null);

    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'pdf',
          content: 'delete',
          name: docFilename,
          mode: 'Delete',
        }),
      });

      const data = await response.json();
      setResult(data);
      onDocumentsChange();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Delete failed';
      setResult({ status: 'Error', error: message });
    } finally {
      setUploading(false);
    }
  };

  const canUpload =
    !uploading &&
    filename.trim() !== '' &&
    (inputMode === 'pdf' ? pdfFile !== null : textContent.trim() !== '');

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Added':
      case 'Updated':
      case 'Deleted':
        return 'var(--success)';
      case 'Skipped':
        return 'var(--warning)';
      case 'Error':
      case 'Not found':
        return 'var(--danger)';
      default:
        return 'var(--muted)';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Added':
      case 'Updated':
      case 'Deleted':
        return (
          <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      case 'Skipped':
        return (
          <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        );
      case 'Error':
      case 'Not found':
        return (
          <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-6 h-full">
      {/* Upload Section */}
      <div
        className="rounded-xl p-5"
        style={{
          background: 'var(--card-bg)',
          border: '1px solid var(--card-border)',
        }}
      >
        <h2
          className="text-sm font-semibold uppercase tracking-wider mb-4"
          style={{ color: 'var(--muted)' }}
        >
          Upload Document
        </h2>

        {/* Input Mode Toggle */}
        <div className="flex gap-1 mb-4 p-1 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)' }}>
          {(['pdf', 'text'] as InputMode[]).map((m) => (
            <button
              key={m}
              onClick={() => {
                setInputMode(m);
                setResult(null);
              }}
              className="flex-1 py-2 px-3 rounded-md text-sm font-medium transition-all duration-200"
              style={{
                background: inputMode === m ? 'var(--accent)' : 'transparent',
                color: inputMode === m ? '#ffffff' : 'var(--muted)',
              }}
            >
              {m === 'pdf' ? '📄 PDF' : '📝 Text'}
            </button>
          ))}
        </div>

        {/* File / Text Input */}
        {inputMode === 'pdf' ? (
          <div className="mb-4">
            <label
              htmlFor="pdf-upload"
              className="flex flex-col items-center justify-center w-full h-28 rounded-lg border-2 border-dashed cursor-pointer transition-all duration-200"
              style={{
                borderColor: pdfFile ? 'var(--accent)' : 'var(--card-border)',
                background: pdfFile ? 'rgba(59,130,246,0.05)' : 'rgba(255,255,255,0.02)',
              }}
            >
              {pdfFile ? (
                <div className="flex items-center gap-2">
                  <svg className="h-5 w-5" style={{ color: 'var(--accent)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                    {pdfFile.name}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>
                    ({(pdfFile.size / 1024).toFixed(1)} KB)
                  </span>
                </div>
              ) : (
                <>
                  <svg className="h-8 w-8 mb-2" style={{ color: 'var(--card-border)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                  </svg>
                  <span className="text-sm" style={{ color: 'var(--muted)' }}>
                    Drop a PDF or click to browse
                  </span>
                </>
              )}
              <input
                id="pdf-upload"
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                onChange={handleFileChange}
                className="hidden"
              />
            </label>
          </div>
        ) : (
          <div className="mb-4">
            <textarea
              value={textContent}
              onChange={(e) => {
                setTextContent(e.target.value);
                setResult(null);
              }}
              placeholder="Paste or type your text content here..."
              rows={5}
              className="w-full rounded-lg p-3 text-sm resize-none outline-none transition-all duration-200"
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid var(--card-border)',
                color: 'var(--foreground)',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'var(--accent)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'var(--card-border)';
              }}
            />
          </div>
        )}

        {/* Filename Input */}
        <div className="mb-4">
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>
            Document Name
          </label>
          <input
            type="text"
            value={filename}
            onChange={(e) => {
              setFilename(e.target.value);
              setResult(null);
            }}
            placeholder={inputMode === 'pdf' ? 'e.g. report.pdf' : 'e.g. notes.txt'}
            className="w-full rounded-lg p-2.5 text-sm outline-none transition-all duration-200"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid var(--card-border)',
              color: 'var(--foreground)',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--card-border)';
            }}
          />
        </div>

        {/* Mode Selector */}
        <div className="mb-4">
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>
            Upload Mode
          </label>
          <div className="flex gap-2">
            {(['Add', 'Replace', 'Delete'] as UploadMode[]).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setResult(null);
                }}
                className="flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-all duration-200"
                style={{
                  background: mode === m ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${mode === m ? 'var(--accent)' : 'var(--card-border)'}`,
                  color: mode === m ? 'var(--accent)' : 'var(--muted)',
                }}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Upload Button */}
        <button
          onClick={handleUpload}
          disabled={!canUpload}
          className="w-full py-2.5 px-4 rounded-lg text-sm font-medium transition-all duration-200 flex items-center justify-center gap-2"
          style={{
            background: canUpload ? 'var(--accent)' : 'rgba(255,255,255,0.05)',
            color: canUpload ? '#ffffff' : 'var(--muted)',
            cursor: canUpload ? 'pointer' : 'not-allowed',
            border: 'none',
          }}
          onMouseEnter={(e) => {
            if (canUpload) e.currentTarget.style.background = 'var(--accent-hover)';
          }}
          onMouseLeave={(e) => {
            if (canUpload) e.currentTarget.style.background = 'var(--accent)';
          }}
        >
          {uploading ? (
            <>
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Uploading…
            </>
          ) : (
            <>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              Upload
            </>
          )}
        </button>

        {/* Result Feedback */}
        {result && (
          <div
            className="mt-3 p-3 rounded-lg flex items-start gap-2 transition-all duration-300"
            style={{
              background: `${getStatusColor(result.status)}10`,
              border: `1px solid ${getStatusColor(result.status)}30`,
            }}
          >
            <span style={{ color: getStatusColor(result.status) }}>
              {getStatusIcon(result.status)}
            </span>
            <div className="text-sm" style={{ color: getStatusColor(result.status) }}>
              <span className="font-medium">{result.status}</span>
              {result.chunks && (
                <span style={{ color: 'var(--muted)' }}> — {result.chunks} chunks indexed</span>
              )}
              {result.reason && (
                <span style={{ color: 'var(--muted)' }}> — {result.reason}</span>
              )}
              {result.error && (
                <span> — {result.error}</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Documents List */}
      <div className="flex-1 min-h-0">
        <DocumentList
          documents={documents}
          onDelete={handleDelete}
          refreshing={refreshing}
        />
      </div>
    </div>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove data URL prefix (e.g., "data:application/pdf;base64,")
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}
