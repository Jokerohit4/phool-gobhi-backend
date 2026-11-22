// Minimal multer storage engine that streams each uploaded file straight to
// Cloudinary via `uploader.upload_stream`. Replaces `multer-storage-cloudinary`,
// which pins cloudinary 1.x (vulnerable, GHSA-g4mf-96x5-5m2c).
//
// Behaviour intentionally mirrors multer-storage-cloudinary@4 so callers do
// not change: the stored file is exposed to multer as
//   { path: secure_url, size: bytes, filename: public_id }
// and `_removeFile` destroys the asset (with CDN invalidation).
export class CloudinaryStorage {
  constructor({ cloudinary, params = {} } = {}) {
    if (!cloudinary) throw new Error('`cloudinary` option required');
    this.cloudinary = cloudinary;
    this.params = params;
  }

  async _uploadOptions(req, file) {
    if (typeof this.params === 'function') return this.params(req, file);
    const options = {};
    for (const [key, value] of Object.entries(this.params)) {
      options[key] = typeof value === 'function' ? await value(req, file) : value;
    }
    return options;
  }

  _handleFile(req, file, callback) {
    this._uploadOptions(req, file)
      .then((options) => new Promise((resolve, reject) => {
        const stream = this.cloudinary.uploader.upload_stream(options, (err, result) => {
          if (err != null) return reject(err);
          return resolve(result);
        });
        file.stream.pipe(stream);
      }))
      .then((result) => callback(undefined, {
        path: result.secure_url,
        size: result.bytes,
        filename: result.public_id,
      }))
      .catch((err) => callback(err));
  }

  _removeFile(req, file, callback) {
    this.cloudinary.uploader.destroy(file.filename, { invalidate: true }, callback);
  }
}
