'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import QueryPanel from '@/components/QueryPanel';

interface Document {
  filename: string;
  sha256: string;
  storage_path: string | null;
  created_at: string;
  updated_at: string;
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<'upload' | 'query' | 'docs'>('upload');
  const [documents, setDocuments] = useState<Document[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Upload form state
  const [uploadMode, setUploadMode] = useState<'Add' | 'Replace' | 'Delete'>('Add');
  const [uploadType, setUploadType] = useState<'file' | 'text'>('file');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [textContent, setTextContent] = useState('');
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Documents tab state
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [docSearch, setDocSearch] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  // Filtered documents based on search
  const filteredDocs = useMemo(() => {
    if (!docSearch.trim()) return documents;
    const query = docSearch.toLowerCase().trim();
    return documents.filter(
      (doc) =>
        doc.filename.toLowerCase().includes(query) ||
        doc.sha256.toLowerCase().includes(query)
    );
  }, [documents, docSearch]);

  // Fetch documents on mount and after upload/delete
  const fetchDocuments = async () => {
    try {
      const res = await fetch('/api/documents');
      const data = await res.json();
      if (data.documents) {
        setDocuments(data.documents);
      }
    } catch (err) {
      console.error('Failed to fetch documents:', err);
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, []);

  // Clear selection when switching tabs or documents change
  useEffect(() => {
    setSelectedDocs(new Set());
    setDocSearch('');
  }, [activeTab]);

  // Toggle a single document checkbox
  const toggleDoc = (filename: string) => {
    setSelectedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) {
        next.delete(filename);
      } else {
        next.add(filename);
      }
      return next;
    });
  };

  // Select/deselect all filtered (visible) documents
  const toggleAllFiltered = () => {
    const filteredFilenames = filteredDocs.map((d) => d.filename);
    const allFilteredSelected = filteredFilenames.every((f) => selectedDocs.has(f));

    if (allFilteredSelected) {
      // Deselect only the filtered ones
      setSelectedDocs((prev) => {
        const next = new Set(prev);
        filteredFilenames.forEach((f) => next.delete(f));
        return next;
      });
    } else {
      // Select all filtered ones
      setSelectedDocs((prev) => {
        const next = new Set(prev);
        filteredFilenames.forEach((f) => next.add(f));
        return next;
      });
    }
  };

  // Select all matching search results
  const selectSearchMatches = () => {
    const matchedFilenames = filteredDocs.map((d) => d.filename);
    setSelectedDocs((prev) => {
      const next = new Set(prev);
      matchedFilenames.forEach((f) => next.add(f));
      return next;
    });
  };

  // Bulk delete selected documents
  const handleBulkDelete = async (filenames: string[]) => {
    if (filenames.length === 0) return;
    const label = filenames.length === 1 ? `"${filenames[0]}"` : `${filenames.length} documents`;
    if (!confirm(`Delete ${label}?`)) return;

    setIsDeleting(true);
    let successCount = 0;
    let failCount = 0;

    for (const filename of filenames) {
      try {
        const formData = new FormData();
        formData.append('name', filename);
        formData.append('mode', 'Delete');

        const res = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });

        const data = await res.json();
        if (data.status === 'Deleted') {
          successCount++;
        } else {
          failCount++;
          console.error(`Failed to delete ${filename}:`, data.error || data.status);
        }
      } catch (err) {
        failCount++;
        console.error(`Failed to delete ${filename}:`, err);
      }
    }

    // Clear selection and refresh
    setSelectedDocs(new Set());
    await fetchDocuments();
    setIsDeleting(false);

    if (failCount > 0) {
      alert(`Deleted ${successCount} document(s). ${failCount} failed.`);
    }
  };

  // Handle file upload
  const handleUpload = async () => {
    setIsLoading(true);
    setUploadStatus('');

    try {
      const formData = new FormData();

      if (uploadMode === 'Delete') {
        const filename = selectedFile?.name || prompt('Enter filename to delete:');
        if (!filename) {
          setUploadStatus('Error: Filename is required for delete');
          setIsLoading(false);
          return;
        }
        formData.append('name', filename);
        formData.append('mode', 'Delete');
      } else {
        formData.append('mode', uploadMode);

        if (uploadType === 'file' && selectedFile) {
          formData.append('file', selectedFile);
          formData.append('name', selectedFile.name);
        } else if (uploadType === 'text' && textContent) {
          formData.append('name', `text-doc-${Date.now()}.txt`);
          formData.append('content', textContent);
        } else {
          setUploadStatus('Error: No content provided');
          setIsLoading(false);
          return;
        }
      }

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (data.status === 'Error') {
        setUploadStatus(`Error: ${data.error}`);
      } else {
        const msg = data.chunks
          ? `${data.status} — ${data.chunks} chunks${data.pages ? `, ${data.pages} pages` : ''}`
          : data.reason
            ? `${data.status}: ${data.reason}`
            : data.status;
        setUploadStatus(msg);
        fetchDocuments();
      }
    } catch (err: any) {
      setUploadStatus(`Error: ${err.message}`);
    }

    setIsLoading(false);
  };

  // Handle single delete from documents list
  const handleDeleteDocument = async (filename: string) => {
    if (!confirm(`Delete "${filename}"?`)) return;

    setIsDeleting(true);
    try {
      const formData = new FormData();
      formData.append('name', filename);
      formData.append('mode', 'Delete');

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (data.status === 'Deleted') {
        fetchDocuments();
        setSelectedDocs((prev) => {
          const next = new Set(prev);
          next.delete(filename);
          return next;
        });
      } else {
        alert(`Delete failed: ${data.error || data.status || 'Unknown error'}`);
      }
    } catch (err: any) {
      alert(`Delete failed: ${err.message}`);
    }
    setIsDeleting(false);
  };

  const allFilteredSelected = filteredDocs.length > 0 && filteredDocs.every((d) => selectedDocs.has(d.filename));

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Header */}
      <header className="border-b border-[var(--card-border)] bg-[var(--card-bg)]">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold text-sm">
              R
            </div>
            <h1 className="text-xl font-semibold text-white">RAG Document Assistant</h1>
          </div>
          <div className="text-sm text-[var(--muted)]">
            {documents.length} document{documents.length !== 1 ? 's' : ''} indexed
          </div>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="max-w-6xl mx-auto px-4 mt-4">
        <div className="flex gap-1 bg-[var(--card-bg)] rounded-lg p-1 border border-[var(--card-border)]">
          {(['upload', 'query', 'docs'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                activeTab === tab
                  ? 'bg-blue-600 text-white'
                  : 'text-[var(--muted)] hover:text-white hover:bg-[var(--card-border)]'
              }`}
            >
              {tab === 'upload' ? 'Upload' : tab === 'query' ? 'Query' : 'Documents'}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* Upload Tab */}
        {activeTab === 'upload' && (
          <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Upload Document</h2>

            {/* Mode Selector */}
            <div className="mb-4">
              <label className="block text-sm text-[var(--muted)] mb-2">Mode</label>
              <div className="flex gap-2">
                {(['Add', 'Replace', 'Delete'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setUploadMode(m)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      uploadMode === m
                        ? m === 'Delete'
                          ? 'bg-red-600 text-white'
                          : 'bg-blue-600 text-white'
                        : 'bg-[var(--card-border)] text-[var(--muted)] hover:text-white'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {uploadMode !== 'Delete' && (
              <>
                {/* Type Selector */}
                <div className="mb-4">
                  <label className="block text-sm text-[var(--muted)] mb-2">Type</label>
                  <div className="flex gap-2">
                    {(['file', 'text'] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => {
                          setUploadType(t);
                          setSelectedFile(null);
                          setTextContent('');
                        }}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                          uploadType === t
                            ? 'bg-blue-600 text-white'
                            : 'bg-[var(--card-border)] text-[var(--muted)] hover:text-white'
                        }`}
                      >
                        {t === 'file' ? 'File' : 'Raw Text'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* File Upload */}
                {uploadType === 'file' && (
                  <div className="mb-4">
                    <label className="block text-sm text-[var(--muted)] mb-2">File</label>
                    <div
                      onClick={() => fileInputRef.current?.click()}
                      className="border-2 border-dashed border-[var(--card-border)] rounded-lg p-8 text-center cursor-pointer hover:border-blue-500 transition-colors"
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.txt,.md,.json"
                        onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                        className="hidden"
                      />
                      {selectedFile ? (
                        <div className="text-white">
                          <p className="font-medium">{selectedFile.name}</p>
                          <p className="text-sm text-[var(--muted)]">
                            {(selectedFile.size / 1024).toFixed(1)} KB
                          </p>
                        </div>
                      ) : (
                        <div className="text-[var(--muted)]">
                          <p className="text-3xl mb-2">+</p>
                          <p>Click to select a file (PDF, TXT, MD)</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Text Content */}
                {uploadType === 'text' && (
                  <div className="mb-4">
                    <label className="block text-sm text-[var(--muted)] mb-2">Text Content</label>
                    <textarea
                      value={textContent}
                      onChange={(e) => setTextContent(e.target.value)}
                      placeholder="Paste your text content here..."
                      className="w-full h-48 bg-[var(--background)] border border-[var(--card-border)] rounded-lg p-3 text-white text-sm resize-none focus:outline-none focus:border-blue-500"
                    />
                  </div>
                )}
              </>
            )}

            {/* Delete filename */}
            {uploadMode === 'Delete' && (
              <div className="mb-4">
                <p className="text-sm text-[var(--muted)]">
                  Select files to delete from the Documents tab.
                </p>
              </div>
            )}

            {/* Submit Button */}
            <button
              onClick={handleUpload}
              disabled={isLoading}
              className={`w-full py-3 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
                uploadMode === 'Delete'
                  ? 'bg-red-600 hover:bg-red-700 text-white'
                  : 'bg-blue-600 hover:bg-blue-700 text-white'
              }`}
            >
              {isLoading
                ? 'Processing...'
                : uploadMode === 'Delete'
                  ? 'Delete Document'
                  : 'Upload Document'}
            </button>

            {/* Status Message */}
            {uploadStatus && (
              <div
                className={`mt-4 p-3 rounded-lg text-sm ${
                  uploadStatus.startsWith('Error')
                    ? 'bg-red-900/20 text-red-400 border border-red-800'
                    : 'bg-green-900/20 text-green-400 border border-green-800'
                }`}
              >
                {uploadStatus}
              </div>
            )}
          </div>
        )}

        {/* Query Tab — streaming RAG chat with optional target-language translation.
            QueryPanel consumes /api/query-stream (SSE) and renders:
              - live pipeline log (translate-stage events included)
              - live-answer token streaming
              - optional live-translated-answer token streaming when a
                target language is selected
            The streaming + translation logic is implemented in
            src/lib/translation-pipeline.ts (ported from ax-translator). */}
        {activeTab === 'query' && (
          <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-xl flex flex-col h-[calc(100vh-200px)] overflow-hidden">
            <QueryPanel documentsCount={documents.length} />
          </div>
        )}

        {/* Documents Tab */}
        {activeTab === 'docs' && (
          <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-xl">
            {/* Header with search and actions */}
            <div className="p-4 border-b border-[var(--card-border)]">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-white">Indexed Documents</h2>
                <div className="flex items-center gap-2">
                  {selectedDocs.size > 0 && (
                    <button
                      onClick={() => handleBulkDelete(Array.from(selectedDocs))}
                      disabled={isDeleting}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                    >
                      {isDeleting
                        ? 'Deleting...'
                        : `Delete Selected (${selectedDocs.size})`}
                    </button>
                  )}
                  <button
                    onClick={fetchDocuments}
                    className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    Refresh
                  </button>
                </div>
              </div>

              {/* Search bar */}
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <svg
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted)]"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                  <input
                    type="text"
                    value={docSearch}
                    onChange={(e) => setDocSearch(e.target.value)}
                    placeholder="Search by filename or SHA256..."
                    className="w-full bg-[var(--background)] border border-[var(--card-border)] rounded-lg pl-10 pr-4 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500"
                  />
                  {docSearch && (
                    <button
                      onClick={() => setDocSearch('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-white transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                {docSearch.trim() && filteredDocs.length > 0 && (
                  <button
                    onClick={selectSearchMatches}
                    className="px-3 py-2 rounded-lg text-xs font-medium bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors whitespace-nowrap"
                  >
                    Select {filteredDocs.length} match{filteredDocs.length !== 1 ? 'es' : ''}
                  </button>
                )}
                {docSearch.trim() && filteredDocs.length > 0 && (
                  <button
                    onClick={() => handleBulkDelete(filteredDocs.map((d) => d.filename))}
                    disabled={isDeleting}
                    className="px-3 py-2 rounded-lg text-xs font-medium bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors whitespace-nowrap disabled:opacity-50"
                  >
                    {isDeleting ? 'Deleting...' : 'Delete Matches'}
                  </button>
                )}
              </div>

              {/* Selection info */}
              {selectedDocs.size > 0 && (
                <div className="mt-2 flex items-center gap-2 text-xs text-[var(--muted)]">
                  <span>{selectedDocs.size} selected</span>
                  <button
                    onClick={() => setSelectedDocs(new Set())}
                    className="text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    Clear selection
                  </button>
                </div>
              )}
            </div>

            {documents.length === 0 ? (
              <div className="p-8 text-center text-[var(--muted)]">
                <p className="text-3xl mb-3">No documents yet</p>
                <p className="text-sm">Upload a document to get started</p>
              </div>
            ) : filteredDocs.length === 0 ? (
              <div className="p-8 text-center text-[var(--muted)]">
                <p className="text-lg mb-2">No matches found</p>
                <p className="text-sm">Try a different search term</p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--card-border)]">
                {/* Select All row */}
                <div className="px-4 py-2 flex items-center gap-3 bg-[var(--card-border)]/20">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleAllFiltered}
                    className="w-4 h-4 rounded border-[var(--card-border)] bg-[var(--background)] text-blue-600 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer accent-blue-600"
                  />
                  <span className="text-xs text-[var(--muted)]">
                    {allFilteredSelected ? 'Deselect all' : 'Select all'}
                    {docSearch.trim() ? ` (${filteredDocs.length} shown)` : ` (${documents.length})`}
                  </span>
                </div>

                {filteredDocs.map((doc) => (
                  <div
                    key={doc.filename}
                    className={`p-4 flex items-center gap-3 transition-colors ${
                      selectedDocs.has(doc.filename)
                        ? 'bg-blue-600/10'
                        : 'hover:bg-[var(--card-border)]/30'
                    }`}
                  >
                    {/* Checkbox */}
                    <input
                      type="checkbox"
                      checked={selectedDocs.has(doc.filename)}
                      onChange={() => toggleDoc(doc.filename)}
                      className="w-4 h-4 rounded border-[var(--card-border)] bg-[var(--background)] text-blue-600 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer accent-blue-600 flex-shrink-0"
                    />

                    {/* Document info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-medium truncate">{doc.filename}</p>
                      <div className="flex items-center gap-3 mt-1 text-xs text-[var(--muted)]">
                        <span>SHA: {doc.sha256.slice(0, 12)}...</span>
                        <span>{doc.storage_path ? 'PDF stored' : 'Text only'}</span>
                        <span>Updated: {new Date(doc.updated_at).toLocaleString()}</span>
                      </div>
                    </div>

                    {/* Individual delete button */}
                    <button
                      onClick={() => handleDeleteDocument(doc.filename)}
                      disabled={isDeleting}
                      className="ml-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors disabled:opacity-50 flex-shrink-0"
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Footer with count */}
            {documents.length > 0 && (
              <div className="px-4 py-3 border-t border-[var(--card-border)] text-xs text-[var(--muted)]">
                {docSearch.trim()
                  ? `Showing ${filteredDocs.length} of ${documents.length} documents`
                  : `${documents.length} document${documents.length !== 1 ? 's' : ''} total`}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
