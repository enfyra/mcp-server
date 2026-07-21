export const filesExamples = {
    title: 'Files, folders, upload metadata, and assets',
    useWhen: 'Use when handling uploads or returning uploaded files.',
    examples: [
      {
        name: 'Upload a file from browser',
        code: `const form = new FormData()
form.append("file", file)
form.append("folder", folderId)
form.append("title", "Invoice")

const uploadId = crypto.randomUUID()
const uploaded = await fetch("/enfyra/enfyra_file", {
  method: "POST",
  credentials: "include",
  headers: { "x-enfyra-upload-id": uploadId },
  body: form
}).then((res) => res.json())`,
        notes: [
          'Do not set Content-Type manually for FormData.',
          'Browser apps use the app-origin /enfyra/enfyra_file proxy path; the Enfyra server endpoint is /enfyra_file.',
          'x-enfyra-upload-id correlates $system:upload:progress events for this upload.',
          'Use file routes/helpers instead of writing binary data into normal tables.',
        ],
      },
      {
        name: 'Use uploaded file in handler',
        code: `const file = @UPLOADED_FILE
if (!file) @THROW400("File is required")

const saved = await @STORAGE.$upload({
  file,
  storageConfig: @BODY.storageConfig,
  folder: @BODY.folder,
  title: @BODY.title,
  description: @BODY.description
})

return saved`,
        notes: [
          'Use file-specific context only in upload-capable routes.',
          'For request uploads, pass file: @UPLOADED_FILE to @STORAGE.$upload/@STORAGE.$update so Enfyra streams from the temp file path.',
          'For upload progress, the client should send x-enfyra-upload-id and listen for the authenticated $system:upload:progress event.',
          'Use @STORAGE.$registerFile when an external process already uploaded the object and the script only needs to create the enfyra_file record.',
          'Do not read @UPLOADED_FILE.path into a Buffer and do not generate examples using @UPLOADED_FILE.buffer.',
          'Use buffer only for small generated or transformed files, such as image thumbnails.',
        ],
      },
    ],
  };
