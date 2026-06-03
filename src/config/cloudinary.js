const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// const createStorage = (folder) => new CloudinaryStorage({
//   cloudinary,
//   params: {
//     folder: `AOVShop/${folder}`,
//     allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
//     transformation: [{ width: 1200, height: 800, crop: 'limit', quality: 'auto' }]
//   }
// });

const createStorage = (folder) => new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isGif = file.mimetype === 'image/gif';
    const isVideo = file.mimetype.startsWith('video/');

    return {
      folder: `AOVShop/${folder}`,
      resource_type: isVideo ? 'video' : 'image',
      allowed_formats: isVideo
        ? ['mp4', 'webm', 'mov']
        : ['jpg', 'jpeg', 'png', 'webp', 'gif'],
      transformation: isGif || isVideo
        ? []
        : [{ width: 1200, height: 800, crop: 'limit', quality: 'auto' }]
    };
  }
});

const avatarStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'AOVShop/avatars',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 200, height: 200, crop: 'fill', gravity: 'face', quality: 'auto' }]
  }
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed'), false);
  }
};

const bannerFileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
    cb(null, true);
  } else {
    cb(new Error('Chỉ chấp nhận file ảnh hoặc video'), false);
  }
};

const uploadAvatar = multer({ storage: avatarStorage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadAccountImages = multer({ storage: createStorage('accounts'), fileFilter, limits: { fileSize: 50 * 1024 * 1024 } });
const uploadBanner = multer({
  storage: createStorage('banners'),
  fileFilter: bannerFileFilter,
  limits: { fileSize: 100 * 1024 * 1024 }
});
const uploadBoxImage = multer({ storage: createStorage('boxes'), fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadSettings = multer({
  storage: createStorage('settings'),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
})

const deleteImage = async (publicId, mediaType = 'image') => {
  try {
    if (!publicId) return;

    await cloudinary.uploader.destroy(publicId, {
      resource_type: mediaType === 'video' ? 'video' : 'image'
    });
  } catch (e) {
    console.error('Cloudinary delete error:', e);
  }
};

const uploadCardThumbnail = multer({
  storage: createStorage('cards'),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
});

module.exports = { cloudinary, uploadAvatar, uploadAccountImages, uploadBanner, uploadBoxImage, uploadSettings, uploadCardThumbnail, deleteImage };