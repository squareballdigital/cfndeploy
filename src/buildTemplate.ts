import { DeploymentBundle, processAssets } from '@squareball/cfnassets';
import {
  BuilderContextProvider,
  TemplateBuilder,
  TemplateFragment,
} from '@squareball/cfntemplate';
import { Readable } from 'stream';
import { DeployStackVersionMetadataKey } from './BaseTemplate.js';

export interface BundleSpec {
  builder: TemplateBuilder;
  bundle: DeploymentBundle;
  name: string;
  version: string;
}

export async function buildTemplate({
  builder,
  bundle,
  name,
  version,
}: BundleSpec): Promise<number> {
  // add all assets to bundle and add assert and version metadata to template
  const ctx = new BuilderContextProvider();

  const template = TemplateFragment.compose(
    TemplateFragment.metadata(DeployStackVersionMetadataKey, version),
    builder,
  );

  const processed = await processAssets(
    template.build({ Resources: {} }, ctx),
    ctx,
    bundle,
  );

  // add template itself to bundle
  await bundle.addAsset(
    `${name}.${version}.template.json`,
    Readable.from(JSON.stringify(processed, null, 2)),
    { keepName: true }, // don't rename with contents hash
  );

  return Object.keys(processed.Resources as any).length ?? 0;
}
