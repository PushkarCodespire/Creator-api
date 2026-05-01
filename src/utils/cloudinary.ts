import { v2 as cloudinary } from 'cloudinary';

export const isCloudinaryConfigured = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

export const uploadToCloudinary = (
  buffer: Buffer,
  folder: string,
  resourceType: 'image' | 'video' | 'raw' | 'auto' = 'auto'
): Promise<string> =>
  new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        { folder: `creator-platform/${folder}`, resource_type: resourceType },
        (error, result) => {
          if (error || !result) reject(error ?? new Error('Cloudinary upload failed'));
          else resolve(result.secure_url);
        }
      )
      .end(buffer);
  });

export const deleteFromCloudinary = async (url: string): Promise<void> => {
  if (!isCloudinaryConfigured) return;
  try {
    // Extract public_id from Cloudinary URL
    const match = url.match(/\/creator-platform\/([^.]+)/);
    if (match) {
      await cloudinary.uploader.destroy(`creator-platform/${match[1]}`);
    }
  } catch {
    // Non-critical — don't throw
  }
};
