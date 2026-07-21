import multer from 'multer';
import cloudinary from '../config/cloudinary.js';

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
      // Square, face-centered crop so avatars look consistent regardless of
      // the source photo's aspect ratio.
      transformation: [{ width: 500, height: 500, crop: 'fill', gravity: 'face', quality: 'auto' }],
    },
  });
} else {
  profilePictureStorage = multer.memoryStorage();
}

export const uploadProfilePicture = multer({
  storage: profilePictureStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB cap
});

// Job application resumes live in GCS, not Cloudinary — see utils/gcsResume.js.
