import multer from 'multer';
import cloudinary from '../config/cloudinary.js';

const hasCloudinary = process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET;

let storage;
if (hasCloudinary) {
  const { CloudinaryStorage } = await import('multer-storage-cloudinary');
  storage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: 'phool-gobhi/gyms',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
      transformation: [{ width: 1200, height: 800, crop: 'limit', quality: 'auto' }],
    },
  });
} else {
  storage = multer.memoryStorage();
}

export const uploadGymImage = multer({ storage });
