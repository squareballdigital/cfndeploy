import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { DeploymentBundle, ProgressStats } from '@squareball/cfnassets';
import { PromisePool } from '@supercharge/promise-pool';
import { TypedEmitter } from 'tiny-typed-emitter';

export interface DeploymentUploaderEvents {
  assetUploadProgress(name: string, stats: ProgressStats): void;
}

export class DeploymentUploader extends TypedEmitter<DeploymentUploaderEvents> {
  public async upload(
    bundle: DeploymentBundle,
    {
      bucket,
      maxConcurrency = 5,
      s3Config,
      s3 = new S3Client(s3Config ?? {}),
    }: {
      bucket: string;
      maxConcurrency?: number;
      s3?: S3Client;
      s3Config?: S3ClientConfig;
    },
  ): Promise<void> {
    await PromisePool.for(bundle.assets)
      .withConcurrency(maxConcurrency)
      .handleError((error) => {
        throw error;
      })
      .process(async (asset) => {
        const upload = new Upload({
          client: s3,
          params: {
            Body: asset.createReadStream(),
            Bucket: bucket,
            Key: asset.name,
          },
        });

        upload.on('httpUploadProgress', (progress) =>
          this.emit('assetUploadProgress', asset.name, {
            progress: progress.loaded,
            total: progress.total ?? asset.size,
          }),
        );

        await upload.done();

        this.emit('assetUploadProgress', asset.name, {
          complete: true,
        });
      });
  }
}
