import { array, object, text } from '@fmtk/decoders';

export const AssetManifestMetadataKey = 'DeployAssetManifest';

export interface AssetDescriptor {
  name: string;
  key: string;
  bucketParam: string;
  keyParam: string;
}

export interface AssetManifest {
  assets: AssetDescriptor[];
}

export const decodeAssetDescriptor = object<AssetDescriptor>({
  name: text,
  key: text,
  bucketParam: text,
  keyParam: text,
});

export const decodeAssetManifest = object<AssetManifest>({
  assets: array(decodeAssetDescriptor),
});
