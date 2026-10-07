// src/config/images/store/cloudinary/cloudinary.config.ts
import { v2 as cloudinary } from 'cloudinary';
import { logger } from '@/shared/logger.util';

// ==================== CLOUDINARY CONFIGURATION ====================
interface CloudinaryConfig {
  cloud_name: string;
  api_key: string;
  api_secret: string;
  secure: boolean;
}

/**
 * Railway / Docker env values often arrive with surrounding quotes or
 * trailing whitespace/newlines. Strip them so Cloudinary gets clean values.
 */
const cleanEnv = (value: string | undefined): string =>
  (value || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();

const maskKey = (key: string): string =>
  key.length > 6 ? `${key.slice(0, 3)}***${key.slice(-3)}` : '***';

/**
 * Cloudinary promise APIs reject with either an Error or { error: {...} }.
 * Normalise both shapes into something loggable.
 */
export const normalizeCloudinaryError = (error: any) => {
  const inner = error?.error || error;
  return {
    message: inner?.message || String(inner),
    httpCode: inner?.http_code,
    name: inner?.name,
  };
};

class CloudinaryConfigManager {
  private isConfigured: boolean = false;

  constructor() {
    this.initializeCloudinary();
  }

  /**
   * Initialize Cloudinary with environment variables
   */
  private initializeCloudinary(): void {
    try {
      const config: CloudinaryConfig = {
        cloud_name: cleanEnv(process.env.CLOUDINARY_CLOUD_NAME),
        api_key: cleanEnv(process.env.CLOUDINARY_API_KEY),
        api_secret: cleanEnv(process.env.CLOUDINARY_API_SECRET),
        // Default to https unless explicitly disabled
        secure: process.env.CLOUDINARY_SECURE_URLS !== 'false',
      };

      if (!config.cloud_name || !config.api_key || !config.api_secret) {
        throw new Error('Missing required Cloudinary configuration');
      }

      cloudinary.config(config);
      this.isConfigured = true;

      logger.info('Cloudinary configured', {
        cloud_name: config.cloud_name,
        api_key: maskKey(config.api_key),
        secure: config.secure,
        timestamp: new Date().toISOString(),
      });

      // Non-blocking startup check: tells us in the logs right away
      // whether Cloudinary is reachable and the credentials are accepted.
      void this.testConnection();
    } catch (error: any) {
      logger.error('Failed to configure Cloudinary', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * Check if Cloudinary is configured
   */
  public isReady(): boolean {
    return this.isConfigured;
  }

  /**
   * Get Cloudinary instance
   */
  public getInstance() {
    if (!this.isConfigured) {
      throw new Error('Cloudinary is not configured');
    }
    return cloudinary;
  }

  /**
   * Test Cloudinary connection
   */
  public async testConnection(): Promise<boolean> {
    try {
      const result = await cloudinary.api.ping();
      logger.info('Cloudinary connection test successful', { result });
      return true;
    } catch (error: any) {
      logger.error('Cloudinary connection test failed', normalizeCloudinaryError(error));
      return false;
    }
  }

  /**
   * Get upload configuration
   */
  public getUploadConfig() {
    return {
      folder: process.env.CLOUDINARY_FOLDER || 'profile-photos',
      uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET || 'profile_photos',
      maxFileSize: parseInt(process.env.CLOUDINARY_MAX_FILE_SIZE || '52428800'),
      autoQuality: process.env.CLOUDINARY_AUTO_QUALITY === 'true',
      autoFormat: process.env.CLOUDINARY_AUTO_FORMAT === 'true',
      fetchFormat: process.env.CLOUDINARY_FETCH_FORMAT || 'auto',
      defaultQuality: process.env.CLOUDINARY_DEFAULT_QUALITY || 'auto:good',
    };
  }
}

// Export singleton instance
const cloudinaryConfig = new CloudinaryConfigManager();

export { cloudinaryConfig };
export default cloudinary;