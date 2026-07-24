sequenceDiagram
    autonumber
    participant U as Browser UI
    participant V as Vercel /api/upload
    participant DB as Supabase Postgres
    participant ST as Supabase Storage
    participant PC as Pinecone e5-large
    participant L as OpenCode GLM-5.1
    participant CR as Supabase Edge Cron

    %% ===== UPLOAD: PDF or TEXT =====
    rect rgb(240, 248, 255)
    Note over V: Error paths: LiteParse fail, Storage fail, Pinecone fail, DB fail -> return {status: "Error", error}<br/>On partial write: DB is commit point. If DB write fails after Storage/Pinecone succeed, cron removes orphaned Storage. Pinecone may require manual re-sync of that filename
    U->>V: POST {type: "pdf"|"text", content, name, mode}

    V->>V: text = liteparse(file).text
    Note over V: LiteParse PDF.js path works on Vercel.<br/>docx/txt/xlsx/images require LibreOffice — not on Vercel serverless.<br/>Route non-PDF formats to a containerised endpoint if needed.

    V->>V: sha256 = hash(text)

    rect rgb(255, 250, 240)
    Note over V,DB: STEP 1: DB filename check gates everything
    V->>DB: SELECT filename, sha256, storage_path FROM documents WHERE filename=name
    end

    alt mode == Delete
        alt Record exists
            V->>ST: remove(name) if storage_path exists
            V->>PC: deleteMany({filename: name})
            V->>DB: DELETE FROM documents
            V-->>U: {status: "Deleted"}
        else Record not found
            V-->>U: {status: "Not found"}
        end
    else mode == Replace
        alt Record not found
            V->>ST: upload(name) if type == "pdf"
            V->>PC: upsertRecords(chunk(text))
            V->>DB: INSERT {filename: name, sha256, storage_path, updated_at}
            V-->>U: {status: "Added", chunks: N}
        else Record exists AND sha256 same
            V-->>U: {status: "Skipped", reason: "Same content"}
        else Record exists AND sha256 different
            V->>ST: upload(name) if type == "pdf"
            V->>PC: deleteMany({filename: name})
            V->>PC: upsertRecords(chunk(text))
            V->>DB: UPDATE {filename: name, sha256, storage_path, updated_at}
            V-->>U: {status: "Updated", chunks: N}
        end
    else mode == Add AND No record
        V->>DB: SELECT filename FROM documents WHERE sha256=incoming_sha256 AND filename!=name
        alt Cross-filename match found
            V-->>U: {status: "Skipped", reason: "Content already exists as <existing_filename>"}
        else No match
            V->>ST: upload(name) if type == "pdf"
            V->>PC: upsertRecords(chunk(text))
            V->>DB: INSERT {filename: name, sha256, storage_path}
            V-->>U: {status: "Added", chunks: N}
        end
    else mode == Add AND sha256 same
        V-->>U: {status: "Skipped", reason: "Same content"}
    else mode == Add AND sha256 different
        V->>ST: upload(name) if type == "pdf"
        V->>PC: deleteMany({filename: name})
        V->>PC: upsertRecords(chunk(text))
        V->>DB: UPDATE {sha256, storage_path, updated_at}
        V-->>U: {status: "Updated", chunks: N}
    end
    end

    %% ===== QUERY: RAG =====
    rect rgb(248, 255, 240)
    Note over U,L: QUERY: RAG — ENHANCED
    U->>V: POST /api/query {query, mode?, filters?, top_k?}
    Note over V: mode: "conversational" (topK=12) or "precise" (topK=5)<br/>Person/entity keywords trigger topK=50 + diversity sampling

    rect rgb(230, 245, 255)
    Note over V: STEP 1: Query Expansion
    V->>V: expandQuery(query) — synonym mapping
    Note over V: owner→responsible,lead,manager<br/>team→group,department,squad<br/>api→endpoint,rest,service
    end

    rect rgb(255, 250, 230)
    Note over V: STEP 2: Pinecone Search
    V->>PC: searchRecords(expandedQuery, topK=12|5|50, minScore=0.50)
    PC-->>V: hits: [{text, filename, score, chunk_index}]
    end

    rect rgb(255, 240, 240)
    Note over V: STEP 3: Source Validation
    V->>DB: SELECT filename FROM documents WHERE filename IN (rawSources)
    V->>V: Filter hits — only keep hits where filename exists in DB
    Note over V: Validates against Supabase — prevents orphaned Pinecone records
    end

    rect rgb(240, 255, 240)
    Note over V: STEP 4: Document Aggregation + Rerank
    V->>V: Group hits by filename
    V->>V: Rerank: avgScore × log(chunkCount + 1)
    Note over V: Merges multiple chunks per document<br/>Promotes docs with many relevant chunks
    end

    rect rgb(255, 248, 240)
    Note over V: STEP 5: LLM Reducer (if multi-chunk)
    alt Aggregated doc has chunkCount > 1
        V->>L: chat.completions(context, REDUCER_PROMPT)
        L-->>V: synthesized(Key Points, Details, Conflicts, Sources)
        Note over V: Synthesizes multi-chunk answers<br/>Extracts key points, detects conflicts
    end
    end

    rect rgb(230, 240, 255)
    Note over V: STEP 6: Final Answer
    V->>L: chat.completions(context + query, SYSTEM_PROMPT)
    Note over V: SYSTEM_PROMPT rules:<br/>1. Use ONLY provided Context<br/>2. Never attribute traits between entities<br/>3. If no relevant info → "I don't have that info"
    alt LLM success
        L-->>V: answer
        V-->>U: {answer, sources, aggregatedContext?, debug?}
    else LLM fail
        V-->>U: {status: "Error", error: "LLM timeout/429/500"}
    end
    end

    %% ===== INGEST: Raw Text =====
    rect rgb(255, 248, 255)
    Note over V: INGEST: Raw Text → Pinecone + Supabase
    U->>V: POST /api/ingest {content, filename, metadata}
    V->>PC: upsertRecords(content, filename, metadata)
    V->>DB: INSERT/UPSERT {filename, sha256, storage_path: null}
    V-->>U: {status: "success", chunksIndexed: N}
    end

    %% ===== CRON CLEANUP =====
    rect rgb(255, 240, 240)
    Note over CR: Hourly cron job. JWT disabled. Runs every 1h
    CR->>DB: SELECT filename FROM documents
    CR->>ST: list all files in bucket
    loop For each bucket file
        CR->>CR: Check if filename in DB result
        alt File orphaned AND older than 1h
            CR->>ST: remove(orphaned_file)
        end
    end
    Note over CR: Prevents bucket accumulation. Stale files handled by overwrite-on-upload<br/>If Pinecone out of sync: re-upload file to trigger deleteMany + upsert
    end
