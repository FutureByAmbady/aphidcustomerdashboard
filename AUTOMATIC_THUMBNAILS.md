# Automatic thumbnails

Implemented in the existing image-processing server at `C:\SmartInsectDetector\backend`, not in Raspberry Pi or motor-control code.

## Successful-image hooks

`backend/app.py` queues thumbnails after a normal processing download of an original, a successful processed-result upload, and a successful developer camera upload. Manual detection result uploads use the same result-upload hook. Source images are only read locally, never modified. No additional original-image downloads, archive traversal, or Storage listing is introduced.

`backend/image_thumbnails.py` creates JPEG derivatives at most 480x360, quality 65, using the image processor's existing OpenCV dependency. Network uploads run in a separate daemon worker. Images and per-image metadata for pending jobs are written atomically to `backend/thumbnail_jobs/`, which is excluded from Git. The queue resumes on server startup; failed uploads retry with capped exponential backoff, independently of detection and original uploads. Preparation errors are logged and do not fail the original operation.

## Paths and metadata

The existing dashboard namespace is retained: `thumbnails/v2/<original object path with .jpg extension>` in the same Supabase image bucket. Uploads use overwrite disabled and a one-year cache TTL. Completed pending JPEGs are removed locally; their small `.metadata.json` sidecars are retained for idempotency. Thumbnail URLs, source paths, dimensions and byte counts are also saved as Supabase Storage user metadata on each derivative. No new detection-table columns or database schema changes are required; APIs derive the same URLs directly from the source URLs without extra Storage reads.

A conflicting existing thumbnail is never overwritten; only that exact object's info is checked to resolve a duplicate upload response. Queue data must remain on persistent disk if the processing server runs in a container. The existing processor must be running to handle images captured/uploaded directly by a device; no new Pi background service is introduced.

## Previews

Customer Image History preview cells and Image Sessions are restored in this change, following the latest request. They and Latest Detection use the shared thumbnail-only component. A refreshed metadata record retries a preview that was requested before its background upload finished. View original/result links are the only route to full-resolution images. The associated processing application's history API and frontend helper use the same v2 thumbnail namespace.

## Activation and scope

Source changes only. Restart/release the existing image-processing backend through its normal workflow to activate the new worker. Dashboard frontend source changes require the normal later build/release. No services were restarted, packages installed, images uploaded, tests run, production builds performed, deployment made, or GitHub push executed during this implementation. No Raspberry Pi, motor, schema, or unrelated database functionality was changed.

Failures of thumbnail preparation (for example an unreadable local image) are logged rather than failing the original workflow; only successfully prepared pending thumbnail uploads are durably retried. The queue is not a historical backfill service.
