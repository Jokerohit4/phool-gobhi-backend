import multer from 'multer';
import cloudinary from '../config/cloudinary.js';

const ALLOWED_PROFILE_MIME = ['image/jpeg', 'image/png', 'image/webp'];

const fileFilterProfile = (req, file, cb) => {
  if (ALLOWED_PROFILE_MIME.includes(file.mimetype)) return cb(null, true);
  cb(new Error('Invalid file type. Only JPG, PNG, and WebP images are allowed.'));
};

const hasCloudinary = process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET;

let profilePictureStorage;
if (hasCloudinary) {
  const { CloudinaryStorage } = await import('multer-storage-cloudinary');
  profilePictureStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: 'phool-gobhi/profile-pictures',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
      transformation: [{ width: 500, height: 500, crop: 'fill', gravity: 'face', quality: 'auto' }],
    },
  });
} else {
  profilePictureStorage = multer.memoryStorage();
}

export const uploadProfilePicture = multer({
  storage: profilePictureStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileFilterProfile,
});

// Job application resumes live in GCS, not Cloudinary — see utils/gcsResume.js.
