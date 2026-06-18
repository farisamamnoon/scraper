import { S3Client, HeadBucketCommand, CreateBucketCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'stream';
import { logger } from '../logger';

export class S3Service {
  private client: S3Client;
  private bucket: string;

  constructor(client: S3Client, bucket: string) {
    this.client = client;
    this.bucket = bucket;
  }

  /**
   * Ensures the target bucket exists. If not, attempts to create it.
   */
  async ensureBucketExists(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      logger.info(`S3 bucket "${this.bucket}" is available.`);
    } catch (error: any) {
      // Check for 404 (NotFound) error in AWS SDK v3
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        logger.warn(`S3 bucket "${this.bucket}" does not exist. Attempting to create it...`);
        try {
          await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
          logger.info(`S3 bucket "${this.bucket}" created successfully.`);
        } catch (createError) {
          logger.error(`Failed to create S3 bucket "${this.bucket}". Please make sure it is created manually.`, createError);
          throw createError;
        }
      } else {
        logger.error(`Failed to query status of bucket "${this.bucket}"`, error);
        throw error;
      }
    }
  }

  /**
   * Uploads a file stream directly to S3.
   * This uses @aws-sdk/lib-storage to stream the file in parts, avoiding loading it into memory.
   */
  async uploadStream(key: string, fileStream: Readable, contentType: string): Promise<void> {
    try {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: fileStream,
          ContentType: contentType,
        },
      });

      await upload.done();
      logger.debug(`Successfully uploaded to S3: ${key}`);
    } catch (error) {
      logger.error(`Failed uploading stream to S3 key: ${key}`, error);
      throw error;
    }
  }

  /**
   * Retrieves an object read stream from S3.
   */
  async getObjectStream(key: string): Promise<{ stream: Readable; contentType?: string; contentLength?: number }> {
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return {
        stream: response.Body as Readable,
        contentType: response.ContentType,
        contentLength: response.ContentLength,
      };
    } catch (error) {
      logger.error(`Failed getting object from S3 key: ${key}`, error);
      throw error;
    }
  }
}
