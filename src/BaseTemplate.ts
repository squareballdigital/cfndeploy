import { ExtraFields, object, optional, text } from '@fmtk/decoders';
import {
  AssetManifest,
  AssetManifestMetadataKey,
  decodeAssetManifest,
} from './AssetManifest.js';

export const DeployStackVersionMetadataKey = 'DeployStackVersion';

export interface BaseTemplate {
  Metadata: {
    [AssetManifestMetadataKey]?: AssetManifest;
    [DeployStackVersionMetadataKey]: string;
  };
}

export const decodeBaseTemplate = object<BaseTemplate>(
  {
    Metadata: object(
      {
        [AssetManifestMetadataKey]: optional(decodeAssetManifest),
        [DeployStackVersionMetadataKey]: text,
      },
      { extraFields: ExtraFields.Include },
    ),
  },
  { extraFields: ExtraFields.Include },
);
